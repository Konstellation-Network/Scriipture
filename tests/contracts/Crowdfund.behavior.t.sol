// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Runs against the Solidity emitted from examples/crowdfund/Crowdfund.ts; see solidity-parity.test.ts.
import "../src/Crowdfund.sol";

struct Log { bytes32[] topics; bytes data; address emitter; }
interface Vm {
    function warp(uint256) external; function deal(address, uint256) external; function prank(address) external;
    function expectRevert(bytes calldata) external; function recordLogs() external; function getRecordedLogs() external returns (Log[] memory);
}

contract CrowdfundTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    Crowdfund cf;
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        cf = new Crowdfund();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function launch(uint256 goal) internal returns (uint256 id) {
        vm.prank(creator);
        id = cf.launch(goal, 7);
    }

    function test_successful_campaign_pays_creator() public {
        uint256 id = launch(3 ether);
        vm.prank(alice); cf.pledge{value: 2 ether}(id);
        vm.prank(bob);   cf.pledge{value: 1.5 ether}(id);
        (uint256 raised, uint256 goal, bool open) = cf.progress(id);
        require(raised == 3.5 ether && goal == 3 ether && open, "progress");

        vm.warp(block.timestamp + 7 days);
        vm.prank(creator); cf.claim(id);
        require(creator.balance == 3.5 ether, "creator paid");
        (,,,, Crowdfund.Status s) = cf.campaigns(id);
        require(s == Crowdfund.Status.Succeeded, "status");
    }

    function test_failed_campaign_refunds_backers() public {
        uint256 id = launch(5 ether);
        vm.prank(alice); cf.pledge{value: 2 ether}(id);
        vm.warp(block.timestamp + 7 days);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.GoalNotMet.selector, 2 ether, 5 ether));
        cf.claim(id);

        vm.prank(alice); cf.refund(id);
        require(alice.balance == 10 ether, "alice made whole");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.NothingToRefund.selector));
        cf.refund(id);
    }

    function test_only_creator_can_claim() public {
        uint256 id = launch(1 ether);
        vm.prank(alice); cf.pledge{value: 1 ether}(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.NotCreator.selector));
        cf.claim(id);
    }

    function test_deadlines_are_enforced() public {
        uint256 id = launch(1 ether);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.CampaignRunning.selector, id));
        cf.claim(id);
        vm.warp(block.timestamp + 7 days);
        (,,, uint64 deadline,) = cf.campaigns(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.CampaignEnded.selector, id, deadline));
        cf.pledge{value: 1 ether}(id);
    }

    function test_input_checks() public {
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.ZeroGoal.selector));
        cf.launch(0, 7);
        vm.expectRevert(abi.encodeWithSelector(Crowdfund.BadDuration.selector));
        cf.launch(1 ether, 91);
    }

    function test_events() public {
        vm.recordLogs();
        uint256 id = launch(1 ether);
        vm.prank(alice); cf.pledge{value: 0.4 ether}(id);
        vm.prank(bob); (bool ok,) = address(cf).call{value: 1 wei}("");
        require(ok && cf.donations() == 1, "donation");
        Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 3, "three events");
        require(logs[0].topics[0] == keccak256("Launched(uint256,address,uint256,uint64)"), "Launched");
        require(logs[0].topics[2] == bytes32(uint256(uint160(creator))), "Launched.creator indexed");
        require(logs[1].topics[0] == keccak256("Pledged(uint256,address,uint256)"), "Pledged");
        require(logs[1].topics[2] == bytes32(uint256(uint160(alice))), "Pledged.backer indexed");
        require(abi.decode(logs[1].data, (uint256)) == 0.4 ether, "Pledged.amount");
        require(logs[2].topics[0] == keccak256("Donated(address,uint256)"), "Donated");
    }
}
