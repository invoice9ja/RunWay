// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AccessControl } from "@openzeppelin/access/AccessControl.sol";
import { Clones } from "@openzeppelin/proxy/Clones.sol";

import { RevenueSplitter } from "./RevenueSplitter.sol";
import { RunwayVault } from "./RunwayVault.sol";

/**
 * @title RunwayFactory
 * @notice Deploys RevenueSplitter clones and registers them with the vault.
 *
 * @dev Each agent gets a minimal proxy clone rather than a full contract, so
 *      onboarding a seller costs a fraction of a direct deployment. The earlier
 *      version advertised clones but deployed full contracts and left its
 *      implementation address unused.
 */
contract RunwayFactory is AccessControl {
    // Set in initialize() so the factory itself can later be deployed as a
    // clone; immutables could only be set in a constructor.
    address payable public vault;
    address public splitterImplementation;
    address public usdc;
    uint256 public defaultShareBps;

    address[] public splitters;

    event SplitterCreated(address indexed splitter, address indexed agent, address payout, uint256 shareBps);

    event FactoryInitialized(address indexed splitterImplementation);

    error FactoryAlreadyInitialized();

    bool private _initialized;

    /**
     * @notice One-time setup for the factory.
     * @dev Separate from a constructor so this factory can itself be deployed as
     *      a clone later. Splitter dependencies are plain storage rather than
     *      immutables for the same reason.
     */
    function initialize(address _vault, address _splitterImplementation, address _usdc, uint256 _defaultShareBps)
        external
    {
        if (_initialized) revert FactoryAlreadyInitialized();
        require(_vault != address(0), "Zero vault");
        require(_splitterImplementation != address(0), "Zero implementation");
        require(_usdc != address(0), "Zero usdc");
        require(_defaultShareBps <= 10000, "Share > 100%");

        _initialized = true;

        vault = payable(_vault);
        splitterImplementation = _splitterImplementation;
        usdc = _usdc;
        defaultShareBps = _defaultShareBps;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        emit FactoryInitialized(_splitterImplementation);
    }

    function getAllSplitters() external view returns (address[] memory) {
        return splitters;
    }

    function getSplittersCount() external view returns (uint256) {
        return splitters.length;
    }

    /// @notice Create a splitter using the factory default share.
    function createSplitter(address agent, address payout) external onlyRole(DEFAULT_ADMIN_ROLE) returns (address) {
        return _createSplitter(agent, payout, defaultShareBps);
    }

    /**
     * @notice Create a RevenueSplitter clone for an agent.
     * @param agent Agent operator
     * @param payout Where the agent's revenue is sent
     * @param shareBps Lender share in basis points, or 0 for the factory default
     */
    function createSplitter(address agent, address payout, uint256 shareBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address)
    {
        uint256 _shareBps = shareBps == 0 ? defaultShareBps : shareBps;
        return _createSplitter(agent, payout, _shareBps);
    }

    function _createSplitter(address agent, address payout, uint256 _shareBps) internal returns (address) {
        require(agent != address(0), "Zero agent");
        require(payout != address(0), "Zero payout");
        require(_shareBps <= 10000, "Share > 100%");

        // Minimal clone: all per-agent state lives in proxy storage.
        address splitter = Clones.clone(splitterImplementation);

        RevenueSplitter(payable(splitter)).initialize(vault, agent, payout, usdc, _shareBps);

        RunwayVault(payable(vault)).registerSplitter(splitter, agent);

        splitters.push(splitter);

        emit SplitterCreated(splitter, agent, payout, _shareBps);

        return splitter;
    }

    function getVault() external view returns (address) {
        return vault;
    }

    function getDefaultShareBps() external view returns (uint256) {
        return defaultShareBps;
    }
}
