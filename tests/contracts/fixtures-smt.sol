// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SmtFixture {
    uint256 public total;

    function add(uint256 x) public {
        total += x;
        assert(total >= x);
    }
}
