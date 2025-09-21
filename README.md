# `UTBC+POL`: Unidirectional Token Bonding Curve + Protocol Owned Liquidity

A token launch mechanism that combines unidirectional bonding curves with automatic liquidity generation.

## Core Concept

`UTBC+POL` solves the liquidity provider risk in token launches by making the protocol itself the permanent liquidity provider.

The system uses a **smart router** that compares prices between two sources:

- **Bonding Curve**: Mathematical pricing formula that mints new tokens
- **Liquidity Pool**: Existing AMM market with actual trading depth

Users always get the better price. When the bonding curve offers a better deal, new tokens are minted and the protocol automatically adds a portion of them to the liquidity pool, paired with the payment received. The protocol permanently holds these liquidity provider tokens.

## Key Mechanics

- **Smart Routing**: Automatic price comparison ensures best execution for buyers
- **Market-Driven Supply**: New tokens only mint when genuine demand exceeds secondary market prices
- **Unidirectional**: Tokens can only be minted through the bonding curve, never redeemed back
- **Protocol Owned Liquidity**: LP tokens are held permanently by the protocol, creating an ever-growing liquidity floor
- **Capital Efficiency**: Zap mechanisms optimize liquidity provision from each minting operation

The result is a self-reinforcing system where growth in demand directly translates to growth in permanent trading infrastructure.

## Resources

- **[Specification](./UTBC+POL%20spec.%20v1.1.0.md)** - Technical implementation details and economic analysis
- **[Simulator](./simulator.js)** - Interactive tokenomics modeling tool
