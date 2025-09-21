# `UTBC+POL`: Unidirectional Token Bonding Curve + Protocol Owned Liquidity

**Specification v1.2.0**

---

## Abstract

`UTBC+POL` creates a self-reinforcing token economy by coupling token minting with permanent liquidity generation. A smart router compares prices between a unidirectional bonding curve and secondary market pool, ensuring optimal execution while systematically building protocol-owned liquidity that cannot be withdrawn. Router fees undergo burning for deflationary pressure.

---

## 1. Design Rationale

### 1.1 Core Innovation

Traditional token launches require external liquidity providers who can withdraw at any time, creating systemic risk. `UTBC+POL` solves this by making liquidity generation integral to token creation—every mint automatically contributes to permanent liquidity.

### 1.2 System Properties

- **Unidirectional Minting**: Tokens only created through bonding curve, never redeemed
- **Automatic POL Formation**: Each mint adds permanent liquidity to XYK pool
- **Infrastructure Premium**: Users receive more tokens while protocol captures arbitrage
- **Self-Sustaining**: No external LPs or emissions required
- **Deflationary**: Router fees burn systematically
- **Precision-First**: Zero token loss through remainder handling

### 1.3 Money Lego Composition

```
Bonding Curve + AMM Pool + Protocol Owned Liquidity = `UTBC+POL`
```

Creates emergent properties:

- Self-bootstrapping from zero state
- Multiple price discovery paths
- Reinforcing mechanisms

---

## 2. Technical Architecture

### 2.1 Core Types

```rust
// Substrate-inspired types for precision
type Balance = u128;      // Token amounts
type Price = u128;        // Price with PRECISION scaling
type Permill = u32;       // Parts per million (0-1_000_000)

const Precision: u128 = 1_000_000_000_000;  // 10^12
```

### 2.2 Smart Router

```rust
struct Router;

impl Router {
    fn execute_swap(
        user: AccountId,
        foreign_in: Balance,
        min_native_out: Balance
    ) -> Result<Balance, Error> {
        let foreign_fee = Self::calculate_fee(foreign_in, ROUTER_FEE);
        let foreign_net = foreign_in.saturating_sub(foreign_fee);

        FeeManager::receive_foreign(foreign_fee);

        // Compare user-received amounts
        let tbc_output = BondingCurve::calculate_user_receives(foreign_net);
        let xyk_output = XykPool::get_output_amount(foreign_net);

        // Route to best price for user
        if tbc_output >= min_native_out && tbc_output >= xyk_output {
            BondingCurve::mint_with_distribution(user, foreign_net)
        } else if xyk_output >= min_native_out {
            XykPool::swap(user, foreign_net)
        } else {
            Err(Error::SlippageExceeded)
        }
    }

    fn calculate_fee(amount: Balance, rate: Permill) -> Balance {
        rate.mul_floor(amount)
    }
}
```

### 2.3 Bonding Curve Mathematics

```rust
struct BondingCurve;

impl BondingCurve {
    fn spot_price(supply: Balance) -> Price {
        let slope_contribution = SLOPE.mul_floor(supply);
        INITIAL_PRICE.saturating_add(slope_contribution)
    }

    fn calculate_mint(payment: Balance) -> Balance {
        // Constant price case
        if SLOPE.is_zero() {
            return payment
                .saturating_mul(Precision)
                .saturating_div(INITIAL_PRICE);
        }

        // Linear curve: solve quadratic equation
        // Using u256 for intermediate calculations to prevent overflow
        let supply = Self::total_supply();

        let a = u256::from(SLOPE);
        let b = u256::from(2u128)
            .saturating_mul(u256::from(INITIAL_PRICE))
            .saturating_mul(u256::from(Permill::ACCURACY))
            .saturating_add(
                u256::from(2u128)
                    .saturating_mul(u256::from(SLOPE.deconstruct()))
                    .saturating_mul(u256::from(supply))
            );
        let c = u256::from(2u128)
            .saturating_mul(u256::from(payment))
            .saturating_mul(u256::from(Permill::ACCURACY))
            .saturating_mul(u256::from(Precision));

        // Quadratic formula with positive root
        let discriminant = b.saturating_pow(2)
            .saturating_add(a.saturating_mul(c).saturating_mul(4u32.into()));
        let sqrt_disc = IntegerSquareRoot::integer_sqrt(discriminant);

        if sqrt_disc <= b {
            return 0;
        }

        let numerator = sqrt_disc.saturating_sub(b);
        let denominator = a.saturating_mul(2u32.into());

        // Safe downcast after division
        let result = numerator.saturating_div(denominator);
        result.try_into().unwrap_or(0)
    }

    fn calculate_user_receives(payment: Balance) -> Balance {
        let total = Self::calculate_mint(payment);
        USER_SHARE.mul_floor(total)
    }
}
```

### 2.4 Token Distribution

```rust
struct Distribution;

impl Distribution {
    const USER: Permill = Permill::from_parts(333_333);      // 33.33%
    const POL: Permill = Permill::from_parts(333_333);       // 33.33%
    const TREASURY: Permill = Permill::from_parts(222_222);  // 22.22%
    const TEAM: Permill = Permill::from_parts(111_112);      // 11.11% + remainder

    fn mint_with_distribution(
        buyer: AccountId,
        payment: Balance
    ) -> Result<Balance, Error> {
        let total_minted = BondingCurve::calculate_mint(payment);

        // Calculate allocations
        let user_amount = Self::calculate_share(total_minted, Self::USER);
        let pol_amount = Self::calculate_share(total_minted, Self::POL);
        let treasury_amount = Self::calculate_share(total_minted, Self::TREASURY);

        // Team gets remainder for perfect conservation
        let team_amount = total_minted
            .saturating_sub(user_amount)
            .saturating_sub(pol_amount)
            .saturating_sub(treasury_amount);

        // Execute transfers
        Token::transfer(&buyer, user_amount)?;
        Token::transfer(&TREASURY, treasury_amount)?;
        Token::transfer(&TEAM, team_amount)?;

        // Form POL with zap mechanism
        PolManager::add_liquidity_with_zap(pol_amount, payment)?;

        Ok(user_amount)
    }

    fn calculate_share(amount: Balance, share: Permill) -> Balance {
        share.mul_floor(amount)
    }
}
```

### 2.5 Zap Mechanism for POL

```rust
struct PolManager {
    native_buffer: Balance,
    foreign_buffer: Balance,
}

impl PolManager {
    fn add_liquidity_with_zap(
        native: Balance,
        foreign: Balance
    ) -> Result<(), Error> {
        // Include buffered amounts
        let total_native = native.saturating_add(Self::native_buffer());
        let total_foreign = foreign.saturating_add(Self::foreign_buffer());

        let (pool_native, pool_foreign) = XykPool::reserves();

        // Bootstrap case - buffer until pool initialized
        if pool_native == 0 || pool_foreign == 0 {
            Self::set_buffers(total_native, total_foreign);
            return Ok(());
        }

        // Calculate balanced liquidity amounts
        let ratio = Self::calculate_ratio(pool_foreign, pool_native);
        let foreign_needed = Self::apply_ratio(total_native, ratio);

        if total_foreign >= foreign_needed {
            // Add balanced liquidity
            let lp_tokens = XykPool::add_liquidity(
                total_native,
                foreign_needed
            )?;
            Protocol::hold_forever(lp_tokens);

            // Convert excess foreign to native
            let excess = total_foreign.saturating_sub(foreign_needed);
            Self::handle_excess_foreign(excess);
        } else {
            // Need more foreign - swap some native
            let native_needed = Self::apply_inverse_ratio(total_foreign, ratio);
            let excess_native = total_native.saturating_sub(native_needed);

            let lp_tokens = XykPool::add_liquidity(
                native_needed,
                total_foreign
            )?;
            Protocol::hold_forever(lp_tokens);

            Self::handle_excess_native(excess_native);
        }

        Ok(())
    }

    fn calculate_ratio(a: Balance, b: Balance) -> u256 {
        u256::from(a)
            .saturating_mul(u256::from(Precision))
            .saturating_div(u256::from(b))
    }
}
```

### 2.6 Fee Burning Mechanism

```rust
struct FeeManager {
    native_buffer: Balance,
    foreign_buffer: Balance,
    total_burned: Balance,
}

impl FeeManager {
    const MIN_SWAP_AMOUNT: Balance = 1_000;

    fn receive_foreign(amount: Balance) {
        let new_buffer = Self::foreign_buffer().saturating_add(amount);

        if new_buffer >= Self::MIN_SWAP_AMOUNT {
            match XykPool::swap_foreign_to_native(new_buffer) {
                Ok(native_amount) => {
                    Self::set_foreign_buffer(0);
                    let buffer = Self::native_buffer().saturating_add(native_amount);
                    Self::set_native_buffer(buffer);
                    Self::try_burn_buffer();
                }
                Err(_) => {
                    Self::set_foreign_buffer(new_buffer);
                }
            }
        } else {
            Self::set_foreign_buffer(new_buffer);
        }
    }

    fn try_burn_buffer() {
        let buffer = Self::native_buffer();
        if buffer > 0 {
            Token::burn(buffer);
            Self::set_native_buffer(0);
            let total = Self::total_burned().saturating_add(buffer);
            Self::set_total_burned(total);
        }
    }
}
```

### 2.7 Protection & Validation

```rust
impl BondingCurve {
    const MIN_INITIAL_MINT: Balance = 100_000;
    const MIN_TRADE_AMOUNT: Balance = 1_000;

    fn validate_trade(amount: Balance) -> Result<(), Error> {
        if Self::total_supply() == 0 && amount < Self::MIN_INITIAL_MINT {
            return Err(Error::InitialMintBelowMinimum);
        }
        if amount < Self::MIN_TRADE_AMOUNT {
            return Err(Error::BelowMinimumTrade);
        }
        Ok(())
    }
}

impl XykPool {
    fn validate_reserves(
        amount_out: Balance,
        reserve: Balance
    ) -> Result<(), Error> {
        // Prevent draining more than 10% of reserves
        let max_out = reserve.saturating_mul(10) / 100;
        if amount_out > max_out {
            return Err(Error::InsufficientReserves);
        }
        Ok(())
    }
}
```

---

## 3. Economic Model

### 3.1 Supply Dynamics

Supply expands only when TBC offers better price than secondary market:

- Linear pricing creates predictable cost curve
- Infrastructure premium ensures sustainable funding
- No arbitrary minting or inflation

### 3.2 Infrastructure Premium

When users buy through TBC, they receive 33.3% of minted tokens—but this is MORE than the secondary market offers. The protocol captures the difference as arbitrage profit, not user tax:

```
Example: XYK offers 100 tokens for 1 ETH
         TBC produces 303 tokens for 1 ETH
         User receives 101 tokens (wins)
         Protocol keeps 202 tokens (wins)
```

### 3.3 Value Flows

```
User Buy → Mint → POL Growth → Deeper Liquidity → Better Prices
          ↘ Treasury → Development → Protocol Growth
           ↘ Team → Alignment → Sustainability
            ↘ Burning → Scarcity → Value Accrual
```

---

## 4. Configuration

```rust
struct Config {
    // Bonding curve
    initial_price: Price,
    slope: Permill,

    // Distribution shares (must sum to 1_000_000)
    user_share: Permill,        // from_parts(333_333)
    pol_share: Permill,         // from_parts(333_333)
    treasury_share: Permill,    // from_parts(222_222)
    team_share: Permill,        // from_parts(111_112)

    // Fees
    router_fee: Permill,        // from_parts(2_000) = 0.2%
    xyk_fee: Permill,           // from_parts(3_000) = 0.3%

    // Protection
    min_initial_mint: Balance,  // 100_000
    min_swap_amount: Balance,  // 1_000
}

enum Error {
    InsufficientAmount,
    InsufficientReserves,
    SlippageExceeded,
    PoolNotInitialized,
    BelowMinimumTrade,
    InitialMintBelowMinimum,
}
```

---

## 5. Implementation Guidelines

### 5.1 Precision Requirements

- Use `u128` for all `Balance` types
- Use `u256` for intermediate calculations to prevent overflow
- Scale prices with `Precision` (10^12)
- Use `Permill` for all percentages with `from_parts()` and `mul_floor()`
- Ensure remainder handling for perfect token conservation

### 5.2 Critical Invariants

1. **Conservation**: `minted = user + pol + treasury + team`
2. **Monotonicity**: Bonding curve price only increases
3. **Liquidity**: POL tokens held forever, never withdrawn
4. **Deflation**: Burned tokens removed from supply permanently

### 5.3 Testing Focus

- Precision loss across operations
- Buffer state transitions
- Edge cases at pool initialization
- Overflow protection in calculations
- Slippage protection effectiveness

---

## 6. Advantages & Trade-offs

**Advantages:**

- No rug pull risk through permanent POL
- Fair launch with transparent linear pricing
- Self-sustaining without external dependencies
- Multiple aligned incentive mechanisms
- Graceful degradation through buffering

**Trade-offs:**

- Higher gas costs from multiple operations
- One-way conversion limits arbitrage
- Initial bootstrap threshold required
- Complexity vs simple bonding curves

---

## 7. Conclusion

`UTBC+POL` fundamentally rethinks token launch mechanics by coupling creation with permanent liquidity and transforming distribution into arbitrage capture. The system creates robust, self-sustaining economics that align all participants while solving the bootstrapping problem through systematic infrastructure building.

---

## Change Log

### v1.2.0 (September 2025)

- Introduced bootstrap protection
- Added fee burning mechanism
- Infrastructure premium model clarification
- Enhanced Zap mechanism documentation

### v1.1.0 (September 2025)

- Enhanced economic model with Zap efficiency considerations
- Clarified buffer management in POL operations

### v1.0.0 (June 2025)

- Introduced core concept

---

- **Version**: 1.2.0
- **Date**: September 2025
- **Author**: Viacheslav Shebuniaev
- **License**: MIT
