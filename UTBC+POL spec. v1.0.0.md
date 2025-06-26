# `UTBC+POL`: Unidirectional Token Bonding Curve + Protocol Owned Liquidity

**Specification v1.0.0**

---

## Abstract

`UTBC+POL` (Unidirectional Token Bonding Curve + Protocol Owned Liquidity) creates a self-reinforcing token economy by linking token minting directly to liquidity generation. The system features a smart router that compares prices between a unidirectional bonding curve and a secondary market pool, ensuring users always get the best price. When minting occurs, it automatically expands the protocol-owned liquidity pool, creating permanent trading infrastructure that cannot be withdrawn.

---

## 1. Design Rationale

### 1.1 Core Innovation

Traditional token launches face a fundamental dilemma: they need liquidity to function, but liquidity providers can withdraw at any time, creating systemic risk. `UTBC+POL` solves this by making liquidity generation an integral part of the token creation process itself.

### 1.2 System Properties

- **Unidirectional Minting**: Tokens can only be created through the bonding curve, never redeemed
- **Automatic POL Formation**: Each mint operation permanently adds liquidity to the XYK pool
- **Price Discovery**: Router-based arbitrage between TBC and secondary market
- **Self-Sustaining**: No external liquidity providers or ongoing emissions required

---

## 2. Technical Architecture

### 2.1 Smart Router

The router is the system's decision engine, ensuring optimal execution for every transaction:

```rust
fn execute_optimal_swap(
    user: AccountId,
    reserve_in: Balance,
    min_tokens_out: Balance,
) -> Result<Balance, Error> {
    let tbc_quote = tbc::get_quote(reserve_in)?;
    let xyk_quote = xyk::get_quote(reserve_in)?;

    if tbc_quote.tokens_out >= xyk_quote.tokens_out {
        // Route through TBC (triggers minting)
        tbc::mint_with_distribution(user, reserve_in, min_tokens_out)
    } else {
        // Route through XYK (secondary market)
        xyk::swap(user, reserve_in, min_tokens_out)
    }
}
```

### 2.2 Unidirectional Token Bonding Curve

The TBC implements a linear pricing function where each token costs slightly more than the previous:

```rust
// Spot price at current supply
fn get_spot_price(total_supply: Balance) -> Price {
    initial_price + slope * total_supply
}

// Calculate tokens minted for given reserve amount
fn calculate_tokens_to_mint(reserve_amount: Balance) -> Result<Balance, Error> {
    // Solve quadratic equation: (slope/2)q² + spot_price*q - reserve_amount = 0
    let spot_price = get_spot_price(current_supply);
    let discriminant = spot_price * spot_price + 2 * slope * reserve_amount;
    let tokens_minted = (sqrt(discriminant) - spot_price) / slope;
    Ok(tokens_minted)
}
```

### 2.3 Protocol Owned Liquidity

When minting occurs, tokens are distributed according to a fixed allocation:

```rust
pub struct Distribution {
    pub user_allocation: Percentage,     // 33.3(3)% - tokens to buyer
    pub pol_allocation: Percentage,      // 33.3(3)% - tokens for liquidity pool
    pub treasury_allocation: Percentage, // 22.2(2)% - tokens for operations
    pub team_allocation: Percentage,     // 11.1(1)% - tokens for team
}

pub struct PolInfo {
    pub lp_token_id: AssetId,
    pub total_lp_tokens_held: Balance,      // LP tokens held by protocol
    pub total_token_contributed: Balance,   // Total tokens added to pool
    pub total_reserve_contributed: Balance, // Total reserves added to pool
}
```

**Critical mechanism**: The entire reserve amount from the user is paired with the POL allocation of newly minted tokens and added to the XYK pool. The protocol permanently holds the resulting LP tokens.

### 2.4 Operational Flow

1. **User submits buy order** with reserve tokens
2. **Router compares prices** between TBC and XYK pool
3. **If TBC offers better price**:
   - New tokens are minted per the bonding curve formula
   - Tokens distributed according to allocation percentages
   - POL tokens + entire reserve amount added to XYK pool
   - Protocol retains LP tokens permanently
4. **If XYK offers better price**:
   - Simple swap executed on secondary market
   - No new tokens minted
   - Existing liquidity depth utilized

### 2.5 Initial Bootstrap

The system starts with zero tokens and no liquidity pool:

- **First purchase** must go through TBC (no XYK pool exists yet)
- This creates the initial token supply and establishes the XYK pool
- Subsequent purchases route optimally based on price comparison

---

## 3. Economic Model

### 3.1 Supply Dynamics

Token supply grows only when the TBC offers a better price than the secondary market. This creates a natural ceiling where:

- Strong demand → Market price rises → TBC becomes attractive → New supply minted
- Weak demand → Market price falls → XYK becomes attractive → No new supply

### 3.2 Liquidity Properties

**Permanent Liquidity Floor**: Every mint operation adds locked liquidity that can never be withdrawn, creating an ever-growing foundation for trading.

**Asymmetric Market**:

- Buying: Unlimited capacity via TBC, market depth via XYK
- Selling: Limited to XYK pool depth only
- This asymmetry naturally supports price during growth phases

### 3.3 Revenue Streams

- XYK trading fees accrue to LP token holders (including the protocol)
- Optional router fees for protocol sustainability
- Treasury allocation funds ongoing development

---

## 4. Implementation Specification

### 4.1 Core Interfaces

```rust
// Router - User entry point
pub fn swap_tokens(
    origin: OriginFor<T>,
    reserve_amount: T::Balance,
    min_tokens_out: T::Balance,
) -> DispatchResult;

// TBC - Minting logic
pub trait UtbcMinter<T: Config> {
    fn mint_with_distribution(
        buyer: T::AccountId,
        reserve_amount: T::Balance,
    ) -> Result<TokenDistribution, Error>;

    fn get_quote(reserve_amount: T::Balance) -> Result<Quote, Error>;
}

// POL Manager - Liquidity handling
pub trait PolManager<T: Config> {
    fn add_liquidity_and_retain_lp(
        token_amount: T::Balance,
        reserve_amount: T::Balance,
    ) -> DispatchResult;

    fn get_pol_info() -> PolInfo;
}
```

### 4.2 Configuration

```rust
pub struct UtbcConfig {
    // Linear curve parameters
    pub initial_price: Price,
    pub slope: Slope,

    // Mint distribution
    pub user_allocation: Percentage,     // 33.3(3)%
    pub pol_allocation: Percentage,      // 33.3(3)%
    pub treasury_allocation: Percentage, // 22.2(2)%
    pub team_allocation: Percentage,     // 11.1(1)%

    // Fee parameters
    pub xyk_fee: Percentage,             // 0.2%
    pub router_fee: Option<Percentage>,  // 0.1%
}
```

---

## 5. Advantages & Trade-offs

### 5.1 Advantages

- **No Rug Pull Risk**: Liquidity cannot be withdrawn
- **Fair Launch**: No pre-mine, transparent pricing
- **Sustainable Economics**: Self-funding through built-in revenue streams
- **Market-Driven Supply**: Minting responds to genuine demand

### 5.2 Trade-offs

- **Complexity**: More complex than simple token sales
- **One-Way Conversion**: No redemption through TBC may limit some strategies
- **Selling Dependency**: Exit liquidity limited to XYK pool depth

---

## 6. Conclusion

`UTBC+POL` represents a fundamental rethinking of token launch mechanics. By coupling token creation with permanent liquidity provision and using market-based routing, it creates a robust, self-sustaining system that aligns the interests of all participants. The mechanism ensures that growth in token demand directly translates to growth in trading infrastructure, solving the bootstrapping problem while maintaining long-term sustainability.

---

- **Version**: 1.0.0
- **Date**: June 2025
- **Author**: Viacheslav Shebuniaev
- **License**: MIT
