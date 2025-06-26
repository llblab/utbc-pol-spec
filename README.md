# `UTBC+POL`: Unidirectional Token Bonding Curve + Protocol Owned Liquidity

A token launch mechanism that combines unidirectional bonding curves with automatic liquidity generation.

## Overview

`UTBC+POL` addresses common issues in token launches by creating a system where:

- Tokens are minted only when purchased (no pre-mining)
- Each purchase automatically adds permanent liquidity to an AMM pool
- The protocol retains ownership of all liquidity provider tokens
- Pricing follows a predictable mathematical curve

## How It Works

1. **Unidirectional Minting**: Tokens can only be created through purchases, not redeemed through the bonding curve
2. **Automatic POL Formation**: A portion of each mint goes directly into a liquidity pool paired with the buyer's payment
3. **Smart Routing**: Users automatically get the best price between the bonding curve and existing liquidity
4. **Linear Pricing**: Price increases predictably as more tokens are minted

## Key Features

- **No External Liquidity Risk**: Protocol owns LP tokens permanently
- **Fair Price Discovery**: Mathematical pricing eliminates manipulation
- **Bootstrap Friendly**: Starts from zero supply and builds liquidity organically
- **Sustainable**: Self-funding through trading fees and treasury allocation

## Documentation

For detailed technical specifications, implementation details, and economic analysis:

**[View Full Specification](./UTBC+POL%20spec.%20v1.0.0.md)**
