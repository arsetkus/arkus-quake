// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ParametricQuakePool
 * @notice PROTOTYPE for a hackathon. Not audited, not a licensed insurance product.
 *
 * Idea: sponsors fund a pool, anyone can buy a parametric earthquake policy for a
 * beneficiary (location, radius, minimum magnitude, coverage). An off-chain oracle
 * agent cross-checks BMKG and USGS, then N attesters sign an EIP-712 QuakeReport.
 * The contract (not an LLM) decides who gets paid, with deterministic rules.
 *
 * Safety design:
 *  - Full collateralisation: reservedCoverage <= pool assets, so no insolvency/pro-rata logic.
 *  - Waiting period after purchase (anti adverse selection).
 *  - Each eventId can be reported only once (no replay / double claim).
 *  - Challenge window: owner (guardian) may veto a report before claims open.
 *  - Reports older than MAX_REPORT_AGE are rejected.
 *  - LP withdrawals are frozen from each accepted report until its claim window
 *    has passed, so LPs cannot exit at the pre-loss share price (front-running payouts).
 *  - SETTLEMENT_GRACE > MAX_REPORT_AGE + max challenge window + WITHDRAW_LOCK, so a
 *    quake on a policy's last day can still be reported and claimed before release.
 *  - Simulated reports (for demo replay of historical quakes) only work if the
 *    deployment was created with allowSimulated = true (testnet demo only).
 */
contract ParametricQuakePool is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types
    struct QuakeReport {
        bytes32 eventId;      // e.g. keccak256 of the USGS event id
        uint16 magX10;        // magnitude * 10 (7.6 -> 76)
        int32 latE4;          // degrees * 1e4 (south/west negative)
        int32 lonE4;
        uint16 depthKm;
        uint64 occurredAt;    // unix seconds
        bytes32 sourcesHash;  // hash of the raw BMKG + USGS payloads (audit trail)
        bool simulated;       // true = replay of a historical event (demo only)
    }

    struct EventRecord {
        uint16 magX10;
        int32 latE4;
        int32 lonE4;
        uint64 occurredAt;
        uint64 reportedAt;
        bool exists;
        bool vetoed;
        bool simulated;
    }

    struct Policy {
        address beneficiary;
        address sponsor; // who paid the premium (can differ from beneficiary)
        int32 latE4;
        int32 lonE4;
        uint16 radiusKm;
        uint16 minMagX10;
        uint128 coverage;
        uint64 waitingUntil;
        uint64 end;
        bool closed; // paid out or released
    }

    // -------------------------------------------------------------- constants
    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "QuakeReport(bytes32 eventId,uint16 magX10,int32 latE4,int32 lonE4,uint16 depthKm,uint64 occurredAt,bytes32 sourcesHash,bool simulated)"
    );

    uint64 public constant MAX_REPORT_AGE = 7 days;
    uint64 public constant MAX_CHALLENGE_WINDOW = 3 days;
    uint64 public constant WITHDRAW_LOCK = 2 days; // claim time after a report's challenge window, LPs frozen
    // after policy end, before collateral can be released: 7 + 3 + 2 + 2 buffer = 14 days
    uint64 public constant SETTLEMENT_GRACE = 14 days;
    uint64 public constant MIN_DURATION = 1 days;
    uint64 public constant MAX_DURATION = 365 days;
    uint16 public constant MAX_RADIUS_KM = 300;
    uint16 public constant MIN_POLICY_MAG_X10 = 40;
    uint16 public constant MAX_POLICY_MAG_X10 = 95;
    uint256 public constant MIN_LIQUIDITY = 1000; // burned on first deposit (share inflation guard)

    // Indonesia bounding box for policies (keeps the cosine approximation accurate)
    int32 public constant LAT_MIN_E4 = -120000; // 12 S
    int32 public constant LAT_MAX_E4 = 70000;   // 7 N
    int32 public constant LON_MIN_E4 = 950000;  // 95 E
    int32 public constant LON_MAX_E4 = 1420000; // 142 E

    uint256 private constant M_PER_DEG_E4 = 111195; // meters per degree (lat), applied to E4 units / 1e4

    // -------------------------------------------------------------- immutables
    IERC20 public immutable asset;
    uint64 public immutable waitingPeriod;
    uint64 public immutable challengeWindow;
    bool public immutable allowSimulated;

    // ------------------------------------------------------------------ state
    uint256 public nextPolicyId = 1;
    uint256 public reservedCoverage;
    uint64 public withdrawLockedUntil;
    mapping(uint256 => Policy) public policies;
    mapping(bytes32 => EventRecord) public events;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    mapping(address => bool) public isAttester;
    uint8 public attesterCount;
    uint8 public threshold;

    // ----------------------------------------------------------------- events
    event Deposited(address indexed lp, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed lp, uint256 amount, uint256 sharesBurned);
    event PolicyBought(
        uint256 indexed policyId, address indexed sponsor, address indexed beneficiary,
        int32 latE4, int32 lonE4, uint16 radiusKm, uint16 minMagX10, uint128 coverage, uint256 premium, uint64 end
    );
    event ReportSubmitted(bytes32 indexed eventId, uint16 magX10, int32 latE4, int32 lonE4, uint64 occurredAt, bytes32 sourcesHash, bool simulated);
    event EventVetoed(bytes32 indexed eventId);
    event PolicyPaid(uint256 indexed policyId, bytes32 indexed eventId, address indexed beneficiary, uint128 amount);
    event PolicyReleased(uint256 indexed policyId);
    event AttesterSet(address indexed attester, bool allowed);
    event ThresholdSet(uint8 threshold);

    // ------------------------------------------------------------ constructor
    constructor(
        IERC20 asset_,
        uint64 waitingPeriod_,
        uint64 challengeWindow_,
        bool allowSimulated_,
        address[] memory attesters_,
        uint8 threshold_
    ) Ownable(msg.sender) EIP712("ParametricQuakePool", "1") {
        require(address(asset_) != address(0), "asset=0");
        require(waitingPeriod_ <= 30 days, "waiting too long");
        require(challengeWindow_ <= MAX_CHALLENGE_WINDOW, "challenge too long");
        require(threshold_ >= 1 && threshold_ <= attesters_.length, "bad threshold");
        asset = asset_;
        waitingPeriod = waitingPeriod_;
        challengeWindow = challengeWindow_;
        allowSimulated = allowSimulated_;
        for (uint256 i = 0; i < attesters_.length; i++) {
            address a = attesters_[i];
            require(a != address(0) && !isAttester[a], "bad attester");
            isAttester[a] = true;
            attesterCount++;
            emit AttesterSet(a, true);
        }
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    // ------------------------------------------------------- admin (guardian)
    function setAttester(address a, bool allowed) external onlyOwner {
        require(a != address(0), "attester=0");
        if (allowed && !isAttester[a]) {
            isAttester[a] = true;
            attesterCount++;
        } else if (!allowed && isAttester[a]) {
            isAttester[a] = false;
            attesterCount--;
            require(threshold <= attesterCount, "threshold > attesters");
        }
        emit AttesterSet(a, allowed);
    }

    function setThreshold(uint8 t) external onlyOwner {
        require(t >= 1 && t <= attesterCount, "bad threshold");
        threshold = t;
        emit ThresholdSet(t);
    }

    /// @notice Guardian can veto a report only during its challenge window.
    function vetoEvent(bytes32 eventId) external onlyOwner {
        EventRecord storage e = events[eventId];
        require(e.exists && !e.vetoed, "nothing to veto");
        require(block.timestamp < uint256(e.reportedAt) + challengeWindow, "window closed");
        e.vetoed = true;
        emit EventVetoed(eventId);
    }

    // --------------------------------------------------------------- liquidity
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function freeLiquidity() public view returns (uint256) {
        uint256 total = totalAssets();
        return total > reservedCoverage ? total - reservedCoverage : 0;
    }

    function deposit(uint256 amount) external nonReentrant returns (uint256 minted) {
        require(amount > 0, "amount=0");
        uint256 assetsBefore = totalAssets();
        if (totalShares == 0) {
            require(amount > MIN_LIQUIDITY, "first deposit too small");
            minted = amount - MIN_LIQUIDITY;
            totalShares = amount;
            shares[address(0)] = MIN_LIQUIDITY;
        } else {
            require(assetsBefore > 0, "pool wiped out");
            minted = (amount * totalShares) / assetsBefore;
            require(minted > 0, "dust");
            totalShares += minted;
        }
        shares[msg.sender] += minted;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, minted);
    }

    /// @notice Withdraw is limited to liquidity not reserved for active policies.
    function withdraw(uint256 shareAmount) external nonReentrant returns (uint256 amount) {
        require(block.timestamp >= withdrawLockedUntil, "withdrawals locked: claims pending");
        require(shareAmount > 0 && shares[msg.sender] >= shareAmount, "bad shares");
        amount = (shareAmount * totalAssets()) / totalShares;
        require(amount <= freeLiquidity(), "funds reserved for policies");
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, shareAmount);
    }

    // --------------------------------------------------------------- policies
    /// @dev PLACEHOLDER pricing, NOT actuarial. Replace with real risk modelling.
    function ratePerYearBps(uint16 minMagX10, uint16 radiusKm) public pure returns (uint256 r) {
        r = 200 + uint256(radiusKm) / 2;
        if (minMagX10 < 70) r += (70 - uint256(minMagX10)) * 15;
    }

    function quotePremium(uint16 minMagX10, uint16 radiusKm, uint128 coverage, uint64 duration)
        public pure returns (uint256)
    {
        uint256 denom = 10000 * 365 days;
        uint256 num = uint256(coverage) * ratePerYearBps(minMagX10, radiusKm) * duration;
        return (num + denom - 1) / denom; // round up
    }

    function buyPolicy(
        address beneficiary,
        int32 latE4,
        int32 lonE4,
        uint16 radiusKm,
        uint16 minMagX10,
        uint128 coverage,
        uint64 duration
    ) external nonReentrant returns (uint256 id, uint256 premium) {
        require(beneficiary != address(0), "beneficiary=0");
        require(coverage > 0, "coverage=0");
        require(latE4 >= LAT_MIN_E4 && latE4 <= LAT_MAX_E4, "lat outside Indonesia box");
        require(lonE4 >= LON_MIN_E4 && lonE4 <= LON_MAX_E4, "lon outside Indonesia box");
        require(radiusKm >= 1 && radiusKm <= MAX_RADIUS_KM, "bad radius");
        require(minMagX10 >= MIN_POLICY_MAG_X10 && minMagX10 <= MAX_POLICY_MAG_X10, "bad magnitude");
        require(duration >= MIN_DURATION && duration <= MAX_DURATION, "bad duration");
        require(duration > waitingPeriod, "duration <= waiting period");

        premium = quotePremium(minMagX10, radiusKm, coverage, duration);
        asset.safeTransferFrom(msg.sender, address(this), premium);

        reservedCoverage += coverage;
        require(totalAssets() >= reservedCoverage, "pool undercollateralized");

        id = nextPolicyId++;
        uint64 end = uint64(block.timestamp) + duration;
        policies[id] = Policy({
            beneficiary: beneficiary,
            sponsor: msg.sender,
            latE4: latE4,
            lonE4: lonE4,
            radiusKm: radiusKm,
            minMagX10: minMagX10,
            coverage: coverage,
            waitingUntil: uint64(block.timestamp) + waitingPeriod,
            end: end,
            closed: false
        });
        emit PolicyBought(id, msg.sender, beneficiary, latE4, lonE4, radiusKm, minMagX10, coverage, premium, end);
    }

    /// @notice Anyone can free the collateral of an expired policy that was never paid.
    function releaseExpired(uint256 policyId) external {
        Policy storage p = policies[policyId];
        require(p.coverage > 0 && !p.closed, "not releasable");
        require(block.timestamp > uint256(p.end) + SETTLEMENT_GRACE, "grace period");
        p.closed = true;
        reservedCoverage -= p.coverage;
        emit PolicyReleased(policyId);
    }

    // ---------------------------------------------------------------- oracle
    function reportDigest(QuakeReport calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REPORT_TYPEHASH, r.eventId, r.magX10, r.latE4, r.lonE4, r.depthKm,
                    r.occurredAt, r.sourcesHash, r.simulated
                )
            )
        );
    }

    /// @notice Anyone may relay a report; validity comes only from attester signatures.
    /// @param sigs signatures sorted by ascending signer address (prevents duplicates)
    function submitReport(QuakeReport calldata r, bytes[] calldata sigs) external {
        require(!events[r.eventId].exists, "event already reported");
        require(r.magX10 >= 30 && r.magX10 <= 99, "bad magnitude");
        require(r.latE4 >= -900000 && r.latE4 <= 900000, "bad lat");
        require(r.lonE4 >= -1800000 && r.lonE4 <= 1800000, "bad lon");
        require(r.occurredAt <= block.timestamp, "event in future");
        require(block.timestamp - r.occurredAt <= MAX_REPORT_AGE, "report too old");
        require(!r.simulated || allowSimulated, "simulation disabled");
        require(sigs.length >= threshold, "not enough signatures");

        bytes32 digest = reportDigest(r);
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            require(signer > last, "signers unsorted or duplicate");
            require(isAttester[signer], "not an attester");
            last = signer;
        }

        events[r.eventId] = EventRecord({
            magX10: r.magX10,
            latE4: r.latE4,
            lonE4: r.lonE4,
            occurredAt: r.occurredAt,
            reportedAt: uint64(block.timestamp),
            exists: true,
            vetoed: false,
            simulated: r.simulated
        });
        uint64 lockEnd = uint64(block.timestamp) + challengeWindow + WITHDRAW_LOCK;
        if (lockEnd > withdrawLockedUntil) withdrawLockedUntil = lockEnd;
        emit ReportSubmitted(r.eventId, r.magX10, r.latE4, r.lonE4, r.occurredAt, r.sourcesHash, r.simulated);
    }

    // ----------------------------------------------------------------- claims
    function claim(uint256 policyId, bytes32 eventId) external nonReentrant {
        require(_tryPay(policyId, eventId), "not eligible");
    }

    /// @notice Keeper-friendly: skips ineligible policies instead of reverting.
    function claimBatch(bytes32 eventId, uint256[] calldata policyIds) external nonReentrant returns (uint256 paid) {
        for (uint256 i = 0; i < policyIds.length; i++) {
            if (_tryPay(policyIds[i], eventId)) paid++;
        }
    }

    function isEligible(uint256 policyId, bytes32 eventId) public view returns (bool) {
        EventRecord storage e = events[eventId];
        if (!e.exists || e.vetoed) return false;
        if (block.timestamp < uint256(e.reportedAt) + challengeWindow) return false;
        Policy storage p = policies[policyId];
        if (p.coverage == 0 || p.closed) return false;
        if (e.occurredAt < p.waitingUntil || e.occurredAt > p.end) return false;
        if (e.magX10 < p.minMagX10) return false;
        return withinRadius(p.latE4, p.lonE4, e.latE4, e.lonE4, p.radiusKm);
    }

    function _tryPay(uint256 policyId, bytes32 eventId) internal returns (bool) {
        if (!isEligible(policyId, eventId)) return false;
        Policy storage p = policies[policyId];
        p.closed = true;
        reservedCoverage -= p.coverage;
        asset.safeTransfer(p.beneficiary, p.coverage);
        emit PolicyPaid(policyId, eventId, p.beneficiary, p.coverage);
        return true;
    }

    // --------------------------------------------------------------- geometry
    /// @notice Equirectangular approximation, accurate for radius <= 300 km at Indonesian latitudes.
    ///         Uses epicentral distance (depth ignored).
    function withinRadius(int32 aLat, int32 aLon, int32 bLat, int32 bLon, uint16 radiusKm)
        public pure returns (bool)
    {
        uint256 dLat = _abs(int256(aLat) - int256(bLat));
        uint256 dLon = _abs(int256(aLon) - int256(bLon));
        uint256 cosE6 = _cosE6((int256(aLat) + int256(bLat)) / 2);
        uint256 dy = (dLat * M_PER_DEG_E4) / 10000;
        uint256 dx = (((dLon * M_PER_DEG_E4) / 10000) * cosE6) / 1e6;
        uint256 r = uint256(radiusKm) * 1000;
        return dx * dx + dy * dy <= r * r;
    }

    function _cosE6(int256 latE4) internal pure returns (uint256) {
        uint256 x = (_abs(latE4) * 17453) / 10000; // radians * 1e6
        uint256 x2 = (x * x) / 1e6;
        uint256 x4 = (x2 * x2) / 1e6;
        return 1e6 - x2 / 2 + x4 / 24; // Taylor, error < 1e-5 for |lat| < 20 deg
    }

    function _abs(int256 v) internal pure returns (uint256) {
        return v >= 0 ? uint256(v) : uint256(-v);
    }
}
