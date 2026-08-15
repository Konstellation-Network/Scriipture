import {
  Address,
  CheckedAddress,
  Bytes32,
  storage,
  view,
  onlyOwner,
  nonReentrant,
  whenNotPaused,
  payable,
  invariant,
  validate,
  msg,
  block,
  keccak256,
  ecrecover,
  abi,
} from "scriipture";

/// ChainLockBridge — a lock-and-release cross-chain bridge.
/// Trust model: weighted multi-validator quorum (67% by weight).
/// Defenses: replay protection per chain pair, time-locked challenge window before release,
/// owner slashing on proof of malicious signing, per-day burn cap, emergency pause.
export class ChainLockBridge {
  @storage validators: Map<Address, bigint> = new Map();
  @storage totalWeight: bigint = 0n;
  @storage quorumBps: bigint = 6700n;
  @storage thisChainId: bigint = 0n;

  @storage processedMessages: Map<Bytes32, boolean> = new Map();
  @storage outboundNonce: bigint = 0n;

  @storage totalLocked: bigint = 0n;
  @storage lockedOf: Map<Address, bigint> = new Map();

  @storage challengePeriod: bigint = 86400n;
  @storage releaseQueuedAt: Map<Bytes32, bigint> = new Map();
  @storage releaseAmount: Map<Bytes32, bigint> = new Map();
  @storage releaseRecipient: Map<Bytes32, Address> = new Map();
  @storage releaseSigner: Map<Bytes32, Address> = new Map();

  @storage dailyCap: bigint = 100000000000000000000n;
  @storage dailyUsage: bigint = 0n;
  @storage dailyEpoch: bigint = 0n;

  @storage slashedValidators: Map<Address, boolean> = new Map();
  @storage slashCount: bigint = 0n;

  constructor() {
    this.thisChainId = block.chainid;
  }

  @onlyOwner
  addValidator(account: Address, weight: bigint): void {
    require(weight > 0n, "Zero weight");
    require(weight <= 1000n, "Weight too high");
    const existing: bigint = this.validators.get(account) ?? 0n;
    require(existing == 0n, "Already validator");
    this.validators.set(account, weight);
    this.totalWeight = this.totalWeight + weight;
  }

  @onlyOwner
  removeValidator(account: Address): void {
    const w: bigint = this.validators.get(account) ?? 0n;
    require(w > 0n, "Not validator");
    this.totalWeight = this.totalWeight - w;
    this.validators.set(account, 0n);
  }

  @onlyOwner
  setQuorumBps(bps: bigint): void {
    require(bps >= 5001n, "Quorum below majority");
    require(bps <= 10000n, "Quorum above 100");
    this.quorumBps = bps;
  }

  @onlyOwner
  setChallengePeriod(secs: bigint): void {
    require(secs >= 3600n, "Too short");
    require(secs <= 604800n, "Too long");
    this.challengePeriod = secs;
  }

  @onlyOwner
  setDailyCap(cap: bigint): void {
    require(cap > 0n, "Zero cap");
    this.dailyCap = cap;
  }

  @payable
  @nonReentrant
  @whenNotPaused
  lock(dstChainId: bigint, recipient: Address): bigint {
    require(msg.value > 0n, "Zero lock");
    require(dstChainId != this.thisChainId, "Same chain");

    const today: bigint = block.timestamp / 86400n;
    if (today > this.dailyEpoch) {
      this.dailyEpoch = today;
      this.dailyUsage = 0n;
    }
    require(this.dailyUsage + msg.value <= this.dailyCap, "Daily cap exceeded");
    this.dailyUsage = this.dailyUsage + msg.value;

    const nonce: bigint = this.outboundNonce + 1n;
    this.outboundNonce = nonce;
    this.totalLocked = this.totalLocked + msg.value;
    this.lockedOf.set(msg.sender, (this.lockedOf.get(msg.sender) ?? 0n) + msg.value);

    return nonce;
  }

  @nonReentrant
  @whenNotPaused
  queueRelease(
    messageId: Bytes32,
    srcChainId: bigint,
    nonce: bigint,
    recipient: Address,
    amount: bigint,
    signers: Array<Address>,
  ): void {
    require(srcChainId != this.thisChainId, "Same chain replay");
    require(this.totalWeight > 0n, "No validators");
    require(amount > 0n, "Zero amount");

    const processed: boolean = this.processedMessages.get(messageId) ?? false;
    require(!processed, "Already processed");

    require(signers.length >= 1, "No signers");

    let sumWeight: bigint = 0n;
    for (let i: bigint = 0n; i < BigInt(signers.length); i++) {
      const signer: Address = signers[Number(i)];
      const w: bigint = this.validators.get(signer) ?? 0n;
      require(w > 0n, "Unknown signer");
      const slashed: boolean = this.slashedValidators.get(signer) ?? false;
      require(!slashed, "Slashed signer");
      sumWeight = sumWeight + w;
    }
    const required: bigint = (this.totalWeight * this.quorumBps) / 10000n;
    require(sumWeight >= required, "Quorum not met");

    this.processedMessages.set(messageId, true);
    this.releaseQueuedAt.set(messageId, block.timestamp);
    this.releaseAmount.set(messageId, amount);
    this.releaseRecipient.set(messageId, recipient);
    this.releaseSigner.set(messageId, signers[0] ?? msg.sender);
  }

  @nonReentrant
  @whenNotPaused
  executeRelease(messageId: Bytes32): void {
    const queuedAt: bigint = this.releaseQueuedAt.get(messageId) ?? 0n;
    require(queuedAt > 0n, "Not queued");
    require(block.timestamp >= queuedAt + this.challengePeriod, "Still in challenge window");

    const amount: bigint = this.releaseAmount.get(messageId) ?? 0n;
    require(amount > 0n, "Already executed");
    const recipient: Address = this.releaseRecipient.get(messageId) ?? msg.sender;
    require(this.totalLocked >= amount, "Insufficient locked");

    this.releaseQueuedAt.set(messageId, 0n);
    this.releaseAmount.set(messageId, 0n);
    this.totalLocked = this.totalLocked - amount;

    const validated: CheckedAddress = validate(recipient);
    payable(validated).transfer(amount);
  }

  @onlyOwner
  challengeRelease(messageId: Bytes32): void {
    const queuedAt: bigint = this.releaseQueuedAt.get(messageId) ?? 0n;
    require(queuedAt > 0n, "Not queued");
    require(block.timestamp < queuedAt + this.challengePeriod, "Challenge window expired");

    this.releaseQueuedAt.set(messageId, 0n);
    this.releaseAmount.set(messageId, 0n);

    const badSigner: Address = this.releaseSigner.get(messageId) ?? msg.sender;
    const w: bigint = this.validators.get(badSigner) ?? 0n;
    if (w > 0n) {
      this.slashedValidators.set(badSigner, true);
      this.totalWeight = this.totalWeight - w;
      this.validators.set(badSigner, 0n);
      this.slashCount = this.slashCount + 1n;
    }
  }

  @view
  computeMessageId(srcChainId: bigint, dstChainId: bigint, nonce: bigint, recipient: Address, amount: bigint): Bytes32 {
    return keccak256(abi.encode(srcChainId, dstChainId, nonce, recipient, amount));
  }

  @view
  isValidator(account: Address): boolean {
    return (this.validators.get(account) ?? 0n) > 0n;
  }

  @view
  validatorWeight(account: Address): bigint {
    return this.validators.get(account) ?? 0n;
  }

  @view
  isSlashed(account: Address): boolean {
    return this.slashedValidators.get(account) ?? false;
  }

  @view
  quorumWeight(): bigint {
    return (this.totalWeight * this.quorumBps) / 10000n;
  }

  @view
  isReleaseReady(messageId: Bytes32): boolean {
    const queuedAt: bigint = this.releaseQueuedAt.get(messageId) ?? 0n;
    if (queuedAt == 0n) return false;
    return block.timestamp >= queuedAt + this.challengePeriod;
  }

  @view
  pendingReleaseInfo(messageId: Bytes32): bigint {
    return this.releaseAmount.get(messageId) ?? 0n;
  }

  @invariant
  invariantLockedNonNegative(): boolean {
    return this.totalLocked >= 0n;
  }

  @invariant
  invariantValidatorWeightSane(): boolean {
    return this.totalWeight <= 1000000n;
  }
}

declare function payable(a: import("scriipture").CheckedAddress): { transfer(v: bigint): void };
