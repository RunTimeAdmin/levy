// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SubscriptionManager} from "../src/SubscriptionManager.sol";

/// @dev Plan terms with no cycle limit, no intro price and no transfers: the
///      plans the tests used before v2.
function basicTerms(uint256 price, uint256 cycleSeconds, uint256 trialSeconds, uint8 maxFailed)
    pure
    returns (SubscriptionManager.PlanTerms memory t)
{
    t.price = price;
    t.cycleSeconds = cycleSeconds;
    t.trialSeconds = trialSeconds;
    t.maxFailed = maxFailed;
}
