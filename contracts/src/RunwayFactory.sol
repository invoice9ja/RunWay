// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Clones} from "@openzeppelin/proxy/Clones.sol";
import {RevenueSplitter} from "./RevenueSplitter.sol";
import {RunwayVault} from "./RunwayVault.sol";

/**
 * @title RunwayFactory
 * @notice Deploys RevenueSplitter clones and registers them in the vault
 */
contract RunwayFactory is AccessControl {
    address public immutable vault;
    address public immutable splitterImplementation;
    address public immutable usdc;
    uint256 public immutable defaultShareBps;

    address[] public splitters;

    event SplitterCreated(
        address indexed splitter,
        address indexed agent,
        address payout,
        uint256 shareBps
    );

    function getAllSplitters() external view returns (address[] memory) {
        return splitters;
    }

    function getSplittersCount() external view returns (uint256) {
        return splitters.length;
    }

    constructor(
        address _vault,
        address _splitterImplementation,
        address _usdc,
        uint256 _defaultShareBps
    ) AccessControl() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        vault = _vault;
        splitterImplementation = _splitterImplementation;
        usdc = _usdc;
        defaultShareBps = _defaultShareBps;
    }

    /**
     * @notice Create a new RevenueSplitter for an agent
     * @param agent Agent operator address
     * @param payout Payout address for agent withdrawals
     * @param shareBps Lender share in basis points (optional, uses default if 0)
     * @return splitter Address of deployed splitter
     */
    function createSplitter(
        address agent,
        address payout,
        uint256 shareBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (address) {
        return _createSplitter(agent, payout, shareBps);
    }

    /**
     * @notice Create splitter with default shareBps
     */
    function createSplitter(address agent, address payout) external onlyRole(DEFAULT_ADMIN_ROLE) returns (address) {
        return _createSplitter(agent, payout, defaultShareBps);
    }

    function _createSplitter(
        address agent,
        address payout,
        uint256 shareBps
    ) internal returns (address) {
        require(agent != address(0), "Zero agent");
        require(payout != address(0), "Zero payout");

        uint256 _shareBps = shareBps == 0 ? defaultShareBps : shareBps;
        require(_shareBps <= 10000, "Share > 100%");

        // Deploy new RevenueSplitter
        RevenueSplitter newSplitter = new RevenueSplitter(
            vault,
            agent,
            payout,
            usdc,
            _shareBps
        );

        // Register in vault
        RunwayVault(vault).registerSplitter(address(newSplitter), agent);

        splitters.push(address(newSplitter));

        emit SplitterCreated(address(newSplitter), agent, payout, _shareBps);

        return address(newSplitter);
    }

    /**
     * @notice Get vault address
     */
    function getVault() external view returns (address) {
        return vault;
    }

    /**
     * @notice Get default share basis points
     */
    function getDefaultShareBps() external view returns (uint256) {
        return defaultShareBps;
    }
}