import {
  Address,
  CheckedAddress,
  storage,
  view,
  pure,
  onlyOwner,
  nonReentrant,
  whenNotPaused,
  payable,
  invariant,
  validate,
  msg,
  block,
} from "scriipture";

/// YieldVault — a multi-tier staking vault with time-lock, slashing,
/// and emergency pause. Built to exercise the full Scriipture security pipeline.
export class YieldVault {
  @storage totalStaked: bigint = 0n;
  @storage totalRewardsPaid: bigint = 0n;
  @storage minStake: bigint = 1000000000000000000n;
  @storage lockPeriod: bigint = 604800n;
  @storage earlyExitPenaltyBps: bigint = 1000n;
  @storage rewardRateBpsPerYear: bigint = 500n;
  @storage tierBoostBps: bigint = 200n;
  @storage tierThreshold: bigint = 100000000000000000000n;

  @storage stakeOf: Map<Address, bigint> = new Map();
  @storage stakedAt: Map<Address, bigint> = new Map();
  @storage lastClaimAt: Map<Address, bigint> = new Map();
  @storage emergencyMode: boolean = false;

  constructor() {}

  @payable
  @nonReentrant
  @whenNotPaused
  stake(): void {
    require(msg.value >= this.minStake, "Stake below minimum");
    require(!this.emergencyMode, "Emergency mode active");

    const existing: bigint = this.stakeOf.get(msg.sender) ?? 0n;
    const pendingRewards: bigint = this.previewRewards(msg.sender);
    const newStake: bigint = existing + msg.value + pendingRewards;

    this.stakeOf.set(msg.sender, newStake);
    this.stakedAt.set(msg.sender, block.timestamp);
    this.lastClaimAt.set(msg.sender, block.timestamp);
    this.totalStaked = this.totalStaked + msg.value + pendingRewards;
  }

  @nonReentrant
  @whenNotPaused
  unstake(amount: bigint): void {
    const balance: bigint = this.stakeOf.get(msg.sender) ?? 0n;
    require(balance >= amount, "Insufficient stake");
    require(amount > 0n, "Zero amount");

    const stakedAtTs: bigint = this.stakedAt.get(msg.sender) ?? 0n;
    const elapsed: bigint = block.timestamp - stakedAtTs;
    const isEarly: boolean = elapsed < this.lockPeriod;

    let payout: bigint = amount;
    if (isEarly) {
      const penalty: bigint = (amount * this.earlyExitPenaltyBps) / 10000n;
      payout = amount - penalty;
      this.totalRewardsPaid = this.totalRewardsPaid + penalty;
    }

    this.stakeOf.set(msg.sender, balance - amount);
    this.totalStaked = this.totalStaked - amount;
    this.lastClaimAt.set(msg.sender, block.timestamp);

    const validatedRecipient: CheckedAddress = validate(msg.sender);
    payable(validatedRecipient).transfer(payout);
  }

  @nonReentrant
  @whenNotPaused
  claimRewards(): void {
    const owed: bigint = this.previewRewards(msg.sender);
    require(owed > 0n, "No rewards");
    require(address(this).balance >= owed, "Vault underfunded");

    this.lastClaimAt.set(msg.sender, block.timestamp);
    this.totalRewardsPaid = this.totalRewardsPaid + owed;

    const validatedRecipient: CheckedAddress = validate(msg.sender);
    payable(validatedRecipient).transfer(owed);
  }

  @view
  previewRewards(account: Address): bigint {
    const balance: bigint = this.stakeOf.get(account) ?? 0n;
    if (balance == 0n) return 0n;
    const since: bigint = this.lastClaimAt.get(account) ?? 0n;
    const elapsed: bigint = block.timestamp - since;
    let rateBps: bigint = this.rewardRateBpsPerYear;
    if (balance >= this.tierThreshold) {
      rateBps = rateBps + this.tierBoostBps;
    }
    return (balance * rateBps * elapsed) / (10000n * 365n * 86400n);
  }

  @view
  effectiveRate(account: Address): bigint {
    const balance: bigint = this.stakeOf.get(account) ?? 0n;
    if (balance >= this.tierThreshold) {
      return this.rewardRateBpsPerYear + this.tierBoostBps;
    }
    return this.rewardRateBpsPerYear;
  }

  @view
  balanceOf(account: Address): bigint {
    return this.stakeOf.get(account) ?? 0n;
  }

  @onlyOwner
  setLockPeriod(secs: bigint): void {
    require(secs >= 86400n, "Lock too short");
    require(secs <= 31536000n, "Lock too long");
    this.lockPeriod = secs;
  }

  @onlyOwner
  setRewardRate(bps: bigint): void {
    require(bps <= 5000n, "Rate too high");
    this.rewardRateBpsPerYear = bps;
  }

  @onlyOwner
  setPenaltyBps(bps: bigint): void {
    require(bps <= 5000n, "Penalty too high");
    this.earlyExitPenaltyBps = bps;
  }

  @onlyOwner
  enableEmergencyMode(): void {
    this.emergencyMode = true;
  }

  @onlyOwner
  disableEmergencyMode(): void {
    this.emergencyMode = false;
  }

  @payable
  fundVault(): void {}

  @invariant
  invariantStakeBalances(): boolean {
    return this.totalStaked >= 0n;
  }

  @invariant
  invariantRewardsNonNegative(): boolean {
    return this.totalRewardsPaid >= 0n;
  }
}

declare function payable(a: import("scriipture").CheckedAddress): { transfer(v: bigint): void };
declare function address(c: object): { balance: bigint };
