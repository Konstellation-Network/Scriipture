import {
  Address,
  CheckedAddress,
  Indexed,
  Uint64,
  storage,
  view,
  payable,
  nonReentrant,
  modifier,
  param,
  event,
  error,
  msg,
  block,
  emit,
  require,
  validate,
  allowLowLevelCall,
  days,
  _,
} from "scriipture";

declare const onlyCreator: (id: bigint) => MethodDecorator;

export enum Status { Active, Succeeded, Failed }

/** One fundraising campaign. */
export interface Campaign {
  creator: Address;
  goal: bigint;
  raised: bigint;
  deadline: Uint64;
  status: Status;
}

/// Kickstarter-style crowdfunding: pledge before the deadline; the creator
/// claims if the goal is met, otherwise backers take their pledges back.
export class Crowdfund {
  @storage campaigns: Map<bigint, Campaign> = new Map();
  @storage pledges: Map<bigint, Map<Address, bigint>> = new Map();
  @storage campaignCount: bigint = 0n;
  @storage donations: bigint = 0n;

  @event Launched(id: Indexed<bigint>, creator: Indexed<Address>, goal: bigint, deadline: Uint64): void {}
  @event Pledged(id: Indexed<bigint>, backer: Indexed<Address>, amount: bigint): void {}
  @event Claimed(id: Indexed<bigint>, amount: bigint): void {}
  @event Refunded(id: Indexed<bigint>, backer: Indexed<Address>, amount: bigint): void {}
  @event Donated(from: Indexed<Address>, amount: bigint): void {}

  @error CampaignEnded(id: bigint, deadline: Uint64): void {}
  @error CampaignRunning(id: bigint): void {}
  @error GoalNotMet(raised: bigint, goal: bigint): void {}

  @modifier
  onlyCreator(id: bigint): void {
    require(msg.sender === this.campaigns.get(id)!.creator, "not creator");
    _;
  }

  launch(goal: bigint, durationDays: bigint): bigint {
    require(goal > 0n, "zero goal");
    require(durationDays >= 1n && durationDays <= 90n, "bad duration");
    const id = this.campaignCount;
    this.campaignCount = id + 1n;
    const deadline = (block.timestamp + durationDays * days) as Uint64;
    this.campaigns.set(id, { creator: msg.sender, goal, raised: 0n, deadline, status: Status.Active });
    emit(this.Launched(id, msg.sender, goal, deadline));
    return id;
  }

  @payable
  pledge(id: bigint): void {
    const c = this.campaigns.get(id)!;
    require(c.status === Status.Active, "not active");
    if (block.timestamp >= c.deadline) throw this.CampaignEnded(id, c.deadline);
    require(msg.value > 0n, "zero pledge");
    c.raised += msg.value;
    this.pledges.get(id)!.set(msg.sender, this.pledges.get(id)!.get(msg.sender)! + msg.value);
    emit(this.Pledged(id, msg.sender, msg.value));
  }

  @nonReentrant
  @onlyCreator(param("id"))
  @allowLowLevelCall("pays the campaign creator; the result is checked")
  claim(id: bigint): void {
    const c = this.campaigns.get(id)!;
    if (block.timestamp < c.deadline) throw this.CampaignRunning(id);
    if (c.raised < c.goal) throw this.GoalNotMet(c.raised, c.goal);
    require(c.status === Status.Active, "already settled");
    c.status = Status.Succeeded;
    const creator: CheckedAddress = validate(c.creator);
    const [ok] = creator.call({ value: c.raised }, "");
    require(ok, "payout failed");
    emit(this.Claimed(id, c.raised));
  }

  @nonReentrant
  @allowLowLevelCall("refunds the caller's own pledge; the result is checked")
  refund(id: bigint): void {
    const c = this.campaigns.get(id)!;
    if (block.timestamp < c.deadline) throw this.CampaignRunning(id);
    require(c.raised < c.goal, "goal was met");
    if (c.status === Status.Active) c.status = Status.Failed;
    const amount = this.pledges.get(id)!.get(msg.sender)!;
    require(amount > 0n, "nothing to refund");
    this.pledges.get(id)!.set(msg.sender, 0n);
    const [ok] = msg.sender.call({ value: amount }, "");
    require(ok, "refund failed");
    emit(this.Refunded(id, msg.sender, amount));
  }

  @view
  progress(id: bigint): [bigint, bigint, boolean] {
    const c = this.campaigns.get(id)!;
    return [c.raised, c.goal, block.timestamp < c.deadline];
  }

  @payable
  receive(): void {
    this.donations += msg.value;
    emit(this.Donated(msg.sender, msg.value));
  }
}
