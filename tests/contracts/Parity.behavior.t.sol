// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Runs against the Solidity emitted from tests/contracts/Parity.ts; see solidity-parity.test.ts.
import "../src/Vault.sol";
import "../src/VaultFactory.sol";

struct Log { bytes32[] topics; bytes data; address emitter; }

interface Vm { function recordLogs() external; function getRecordedLogs() external returns (Log[] memory); function warp(uint256) external; function expectRevert(bytes4) external; function expectRevert() external; function expectRevert(bytes calldata) external; function prank(address) external; }

contract GoodToken {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
}
contract RevertingToken {
    function balanceOf(address) external pure returns (uint256) { revert("nope"); }
    function transfer(address, uint256) external pure returns (bool) { return false; }
}

contract ParityTest {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    Vault v;
    receive() external payable {}
    function setUp() public { v = new Vault(); }

    function test_deposit_takes_fee_and_emits() public {
        vm.recordLogs();
        v.deposit{value: 1 ether}();
        require(v.deposits(address(this)) == 0.99 ether, "net deposit");
        require(v.total() == 0.99 ether, "total");

        // Deposited(address indexed who, uint256 amount), declared in the base, emitted by Vault.
        Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1, "exactly one event");
        require(logs[0].emitter == address(v), "emitted by the vault");
        require(logs[0].topics.length == 2, "signature + one indexed topic");
        require(logs[0].topics[0] == keccak256("Deposited(address,uint256)"), "event signature");
        require(logs[0].topics[1] == bytes32(uint256(uint160(address(this)))), "indexed depositor");
        require(abi.decode(logs[0].data, (uint256)) == 0.99 ether, "amount in data");
    }
    function test_deposit_too_small_reverts_with_custom_error() public {
        vm.expectRevert(abi.encodeWithSelector(VaultBase.TooSmall.selector, uint256(1), uint256(0.001 ether)));
        v.deposit{value: 1}();
    }
    function test_receive_counts_plain_transfers() public {
        (bool ok,) = address(v).call{value: 5 wei}("");
        require(ok && v.received() == 5, "receive");
    }
    function test_tuple_returns_and_destructuring() public {
        (uint256 net, uint256 fee) = v.split(1000);
        require(net == 990 && fee == 10, "split");
        v.deposit{value: 1 ether}();
        (uint256 n2, bool hasFee) = v.summary();
        require(n2 == 0.99 ether - 0.0099 ether && hasFee, "summary");
        (uint256 p, uint8 d) = v.price();
        require(p == 1 ether && d == 18, "price");
    }
    function test_modifiers_gate_sweep() public {
        GoodToken t = new GoodToken();
        vm.expectRevert(VaultBase.TooEarly.selector);
        v.sweep(address(t));
        vm.warp(8 days);
        vm.prank(address(0xBEEF));
        vm.expectRevert(VaultBase.NotKeeper.selector);
        v.sweep(address(t));
    }
    function test_try_success_path_transfers() public {
        GoodToken t = new GoodToken();
        t.mint(address(v), 42);
        vm.warp(8 days);
        require(v.sweep(address(t)) == 42, "swept");
        require(t.balanceOf(address(this)) == 42, "keeper got tokens");
        require(v.lastSweep() == 8 days, "lastSweep");
    }
    function test_try_catch_path_on_reverting_token() public {
        RevertingToken t = new RevertingToken();
        vm.warp(8 days);
        require(v.sweep(address(t)) == 0, "caught");
        require(v.lastSweep() == 8 days, "continued after catch");
    }
    function test_narrow_conversion_and_type_max() public view {
        require(v.narrow(7) == 7, "narrow");
    }
    function test_narrow_rejects_overflow() public {
        vm.expectRevert(Vault.TooBig.selector);
        v.narrow(uint256(type(uint64).max) + 1);
    }
    function test_do_while_runs_body_first() public view {
        require(v.countdown(0) == 1, "do-while runs once even when test is false");
        require(v.countdown(5) == 5, "countdown");
    }
    function test_abi_decode_tuple() public view {
        require(v.decode(abi.encode(address(0xCAFE), uint256(3))) == address(0xCAFE), "decode");
    }
    function test_hex_bytes4_literal() public view {
        require(v.selector() == bytes4(keccak256("transfer(address,uint256)")), "selector");
    }
    function test_enum_widening() public view {
        require(v.phaseCode() == 0, "phase");
    }
    function test_factory_new_contract() public {
        VaultFactory f = new VaultFactory();
        address a = f.create();
        require(a.code.length > 0 && f.vaults(0) == a, "factory");
        require(Vault(payable(a)).keeper() == address(f), "created vault keeper is factory");
    }
}
