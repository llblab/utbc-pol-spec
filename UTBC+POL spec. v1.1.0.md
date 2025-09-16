# `UTBC+POL`: Unidirectional Token Bonding Curve + Protocol Owned Liquidity

**Specification v1.1.0**

---

## Abstract

`UTBC+POL` (Unidirectional Token Bonding Curve + Protocol Owned Liquidity) creates a self-reinforcing token economy by linking token minting directly to liquidity generation. The system features a smart router that compares prices between a unidirectional bonding curve and a secondary market pool, ensuring users always get the best price. When minting occurs, it automatically expands protocol-owned liquidity, creating permanent trading infrastructure that cannot be withdrawn.

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
    foreign_in: Balance,
    min_native_out: Balance,
) -> Result<Balance, Error> {
    let tbc_quote = tbc::get_quote(foreign_in)?;
    let xyk_quote = xyk::get_quote(foreign_in)?;

    if tbc_quote.native_out >= xyk_quote.native_out {
        // Route through TBC (triggers minting)
        tbc::mint_with_distribution(user, foreign_in, min_native_out)
    } else {
        // Route through XYK (secondary market)
        xyk::swap(user, foreign_in, min_native_out)
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

// Calculate native minted for given foreign amount
fn calculate_mint(foreign_amount: Balance) -> Balance {
    // Quadratic solution for linear bonding curve
    let spot_price = get_spot_price(current_supply);
    let discriminant = spot_price * spot_price + 2 * slope * foreign_amount;
    (sqrt(discriminant) - spot_price) / slope
}
```

### 2.3 Protocol Owned Liquidity

When minting occurs, tokens are distributed according to a fixed allocation. The protocol adds its allocation to the XYK pool and permanently holds the resulting LP tokens, while other liquidity providers can freely add or remove their own liquidity:

```rust
pub struct Distribution {
    pub user_allocation: Percentage,     // 33.3(3)%
    pub pol_allocation: Percentage,      // 33.3(3)%
    pub treasury_allocation: Percentage, // 22.2(2)%
    pub team_allocation: Percentage,     // 11.1(1)%
}

pub struct PolInfo {
    pub lp_tokens_held: Balance,
    pub native_contributed: Balance,
    pub foreign_contributed: Balance,
}
```

### 2.4 Zap Mechanism for POL

The Zap strategy is specifically designed for UTBC+POL dynamics where operations are distributed over time and the pool price naturally lags behind the TBC price:

```rust
pub trait ZapStrategy {
    fn execute(
        &self,
        pool: &XykPool,
        native_amount: Balance,   // POL allocation of minted tokens
        foreign_amount: Balance,  // Entire reserve amount from user
    ) -> ZapResult;
}

pub struct ZapResult {
    pub lp_minted: Balance,
    pub native_used: Balance,
    pub foreign_used: Balance,
    pub native_rest: Balance,   // Buffered for next operation
    pub foreign_rest: Balance,  // Buffered for next operation
}
```

**Design Rationale**:

The mechanism leverages a key insight: when users buy through TBC (which happens when TBC offers better price), the pool price inherently lags behind. This creates a systematic imbalance - the protocol receives a fixed native amount (33.3% POL allocation) but the entire foreign payment from the user. A naive approach would leave excess foreign idle or create unbalanced positions.

**Zap Execution Flow**:

1. **Proportional Liquidity Addition**: Add maximum balanced liquidity at current pool ratio
   - Uses all available native (POL allocation + buffer)
   - Uses proportional amount of foreign
   - Maximizes LP tokens received

2. **Excess Conversion**: Swap remaining foreign for native
   - Excess foreign exists because pool price < TBC price
   - This swap creates buying pressure on native
   - Helps close the price gap between pool and TBC

3. **Buffer Cycling**: Converted native enters buffer for next operation
   - Not immediately re-added to avoid inefficiency
   - Will be utilized in next mint operation
   - Creates a productive cycle of capital utilization

**Why This Approach**:

- **Price Support**: Each swap of excess foreign → native creates buying pressure, supporting the minted asset price
- **Capital Efficiency**: Every unit of currency is either in LP position or cycling through buffers toward LP
- **Temporal Smoothing**: Buffers allow operations spread over time to benefit from accumulated conversions
- **Self-Reinforcing**: The mechanism naturally counteracts the price lag that triggers it, creating market equilibrium

This design transforms what could be a weakness (price lag) into a strength (systematic price support and liquidity accumulation).

### 2.5 Operational Flow

1. **User submits buy order** with foreign tokens
2. **Router compares prices** between TBC and XYK pool
3. **If TBC offers better price**:
   - New native tokens minted per bonding curve
   - Distributed according to allocation
   - POL allocation + foreign processed through Zap
   - Protocol retains LP tokens
4. **If XYK offers better price**:
   - Simple swap on secondary market
   - No minting occurs

### 2.6 Initial Bootstrap

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

**Capital Efficiency**: The protocol ensures optimum utilization of incoming funds by:

- Adding most funds as balanced liquidity
- Converting excess to productive assets
- Maintaining buffers for operational efficiency

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
pub fn swap(
    foreign_amount: Balance,
    min_native_out: Balance,
) -> Result<Balance, Error>;

// TBC - Minting logic
pub trait UtbcMinter {
    fn mint_with_distribution(
        buyer: AccountId,
        foreign_amount: Balance,
    ) -> Result<MintResult, Error>;

    fn get_quote(foreign_amount: Balance) -> Quote;
}

// POL Manager - Liquidity handling
pub trait PolManager {
    fn add_liquidity_with_zap(
        native_amount: Balance,
        foreign_amount: Balance,
    ) -> Result<ZapResult, Error>;

    fn get_pol_info() -> PolInfo;
}
```

### 4.2 Configuration

```rust
pub struct UtbcConfig {
    // Linear bonding curve
    pub initial_price: Price,
    pub slope: Slope,

    // Mint distribution
    pub user_allocation: Percentage,     // 33.3(3)%
    pub pol_allocation: Percentage,      // 33.3(3)%
    pub treasury_allocation: Percentage, // 22.2(2)%
    pub team_allocation: Percentage,     // 11.1(1)%

    // Fees
    pub xyk_fee: Percentage,
    pub router_fee: Option<Percentage>,
}
```

---

## 5. Advantages & Trade-offs

### 5.1 Advantages

- **No Rug Pull Risk**: Liquidity cannot be withdrawn
- **Fair Launch**: No pre-mine, transparent pricing
- **Sustainable Economics**: Self-funding through built-in revenue streams
- **Market-Driven Supply**: Minting responds to genuine demand
- **Capital Efficiency**: Optimum liquidity depth from every mint operation

### 5.2 Trade-offs

- **Complexity**: More complex than simple token sales
- **One-Way Conversion**: No redemption through TBC may limit some strategies
- **Selling Dependency**: Exit liquidity limited to XYK pool depth

---

## 6. Conclusion

`UTBC+POL` represents a fundamental rethinking of token launch mechanics. By coupling token creation with permanent liquidity provision, it creates a robust, self-sustaining system that aligns the interests of all participants. The system intelligently handles the natural imbalances that occur when market prices lag behind the bonding curve, ensuring optimum capital efficiency through balanced liquidity addition. This design ensures that growth in token demand directly translates to growth in trading infrastructure, solving the bootstrapping problem while maintaining long-term sustainability.

---

## Change Log

### v1.1.0 (September 2025)

- Enhanced economic model with Zap efficiency considerations
- Clarified buffer management in POL operations

### v1.0.0 (June 2025)

- Initial specification release

---

- **Version**: 1.1.0
- **Date**: September 2025
- **Author**: Viacheslav Shebuniaev
- **License**: MIT
