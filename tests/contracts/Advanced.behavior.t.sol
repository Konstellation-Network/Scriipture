// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
// Runs against the Solidity emitted from tests/contracts/Advanced.ts; see solidity-parity.test.ts.
import "../src/Advanced.sol";
import "../src/Broken.sol";
import "../src/Measurer.sol";

struct Log { bytes32[] topics; bytes data; address emitter; }

interface Vm { function recordLogs() external; function getRecordedLogs() external returns (Log[] memory); function deal(address, uint256) external; }

contract AdvancedTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    Advanced a;
    function setUp() public { a = new Advanced(); }

    function test_overloads_share_a_name_and_free_function_clamps() public {
        a.put(7);
        require(a.total() == 7, "put(uint256)");
        a.put(3, 9);
        require(a.total() == 9, "put(uint256,uint256) takes the larger, through the library");
        a.put(5_000_000);
        require(a.total() == 1_000_000, "clamped to the file-level constant");
    }

    function test_named_returns() public {
        a.put(9);
        (uint256 half, bool odd) = a.split();
        require(half == 4 && odd, "split");
    }

    function test_value_type_round_trips() public {
        a.setPrice(123);
        require(a.price() == 123, "wrap / unwrap");
        require(Price.unwrap(a.last()) == 123, "stored as Price");
    }

    function test_function_pointer() public view {
        require(a.nine(2) == 18, "triple twice");
    }

    function test_create2_with_value_lands_at_the_predicted_address() public {
        bytes32 salt = keccak256("s");
        vm.deal(address(this), 1 ether);
        address m = a.spawn{value: 0.25 ether}(salt, 3);
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(a), salt, keccak256(abi.encodePacked(type(Measurer).creationCode, abi.encode(uint256(3))))));
        require(m == address(uint160(uint256(h))), "CREATE2 address");
        require(m.balance == 0.25 ether, "funded through the payable constructor");
        require(a.areaAt(m) == 9, "norm(origin) + side^2, through the interface and the library");
    }

    function test_typed_catch_clauses() public {
        Broken b = new Broken();
        a.probe(address(b), Point(1, 0));
        require(a.outcome() == 1, "catch Error(string)");
        a.probe(address(b), Point(2, 0));
        require(a.outcome() == 2, "catch Panic(0x12)");
        a.probe(address(b), Point(3, 0));
        require(a.outcome() == 3, "catch-all for a custom error");
        Measurer m = new Measurer(2);
        a.probe(address(m), Point(1, 1));
        require(a.outcome() == 6, "success path: 1 + 1 + 2*2");
    }

    function test_anonymous_event_has_four_topics_and_no_signature() public {
        vm.recordLogs();
        a.move(address(0xBEEF), 5);
        Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "one event");
        require(logs[0].topics.length == 4, "four indexed, no signature topic");
        require(logs[0].topics[0] == bytes32(uint256(uint160(address(this)))), "first topic is `from`");
        require(logs[0].topics[3] == keccak256("advanced"), "the file-level constant");
    }

    function test_transient_flag_is_clear_after_the_call() public {
        a.move(address(1), 1);
        require(!a.entered(), "transient storage reset");
        a.move(address(1), 1);
        require(a.total() == 2, "second call not blocked");
    }
}
