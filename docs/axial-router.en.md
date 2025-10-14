# Axial Router Specification

_Deterministic Hub-Anchored Liquidity Router for Substrate Frame Pallets_

## 1. Executive Overview

Axial Router is a Substrate Frame pallet implementing deterministic liquidity routing through designated anchor assets. The system maintains price coherence via TVL-weighted token EMAs while constraining routing complexity to O(#anchors), ensuring predictable gas costs and robust price discovery.

### Core Architecture Principles

- **Token-level oracles** — Single EMA per token aggregated across all pools
- **TVL-weighted aggregation** — Live pool TVL drives routing decisions and price discovery
- **Fixed smoothing** — Single α coefficient applied network-wide for EMA updates
- **Deterministic execution** — Bounded complexity with predictable performance
- **Health-aware routing** — Success/slippage thresholds gate available pools
- **POL-compatible** — Protocol-owned liquidity participates as standard LP positions

### Performance Targets

| Property               | Target Value  | Rationale                        |
| ---------------------- | ------------- | -------------------------------- |
| Routing complexity     | O(#anchors)   | Predictable performance at scale |
| Max hops               | 2             | Balance efficiency vs simplicity |
| Target scale           | 50-500 tokens | Parachain liquidity requirements |
| Gas per swap           | <200k weight  | Economic viability               |
| Price update frequency | Per block     | On-activity updates only         |
| EMA staleness limit    | 30 blocks     | Balance freshness vs update cost |

## 2. System Architecture

### 2.1 Component Overview

```
┌────────────────────────────────────────────────────┐
│ Extrinsics (FRAME)                                 │
│ swap() · add_anchor() · pause_pool() · reset_ema() │
└────────────────────────┬───────────────────────────┘
                         ▼
┌────────────────────────────────────────────────────┐
│ AxialRouter Pallet (Core)                          │
│ • Route Planning & Execution                       │
│ • Health Monitoring                                │
│ • Split Route Allocation (optional)                │
└──────────┬───────────────────────────┬─────────────┘
           ▼                           ▼
┌────────────────────┐      ┌────────────────────────┐
│ Pool Adapters      │      │ Token Oracle Subsystem │
│ • XYK (constant)   │      │ • EMA computation      │
│ • UTBC (optional)  │      │ • Fixed α updates      │
│ • External bridges │      │ • TTL enforcement      │
└────────────────────┘      └────────────────────────┘
```

### 2.2 Pallet Structure

```rust
#[pallet]
pub mod pallet {
    use frame_support::{pallet_prelude::*, traits::fungibles};
    use sp_runtime::{FixedU128, Permill};

    #[pallet::config]
    pub trait Config: frame_system::Config {
        type RuntimeEvent: From<Event<Self>>;
        type Assets: fungibles::Inspect<Self::AccountId>
                   + fungibles::Mutate<Self::AccountId>;
        type MaxAnchors: Get<u32>;
        type MinLiquidity: Get<Balance>;
        type EmaMaxAge: Get<BlockNumberFor<Self>>;
        type WeightInfo: WeightInfo;
    }

    #[pallet::storage]
    #[pallet::getter(fn anchors)]
    pub type Anchors<T> = StorageValue<
        _,
        BoundedVec<AssetId, T::MaxAnchors>,
        ValueQuery
    >;

    #[pallet::storage]
    #[pallet::getter(fn token_oracle)]
    pub type TokenOracles<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        AssetId,
        TokenEMA<BlockNumberFor<T>>
    >;

    #[pallet::storage]
    #[pallet::getter(fn pool_info)]
    pub type Pools<T: Config> = StorageDoubleMap<
        _, Blake2_128Concat, AssetId,  // base
        Blake2_128Concat, AssetId,      // quote
        PoolInfo<T>
    >;

    #[pallet::storage]
    #[pallet::getter(fn config)]
    pub type RouterConfig<T: Config> = StorageValue<
        _,
        SystemConfig<T>,
        ValueQuery
    >;
}
```

### 2.3 Core Data Types

```rust
/// Token-level exponential moving average with health metadata
pub struct TokenEMA<BlockNumber> {
    /// Current EMA price in reference unit (18 decimals)
    pub ema_price: FixedU128,
    /// Last aggregated spot price
    pub last_price: FixedU128,
    /// Block number of last update
    pub last_updated: BlockNumber,
    /// Total liquidity across all pools
    pub total_liquidity: Balance,
    /// Time-to-live in blocks
    pub ttl: BlockNumber,
}

/// Pool information with reserves and health metrics
pub struct PoolInfo<T: Config> {
    /// Pool adapter identifier
    pub pool_id: PoolId,
    /// Current reserves
    pub reserve_base: Balance,
    pub reserve_quote: Balance,
    /// Total value locked (includes POL shares)
    pub tvl: Balance,
    /// Last activity timestamp
    pub last_activity: BlockNumberFor<T>,
    /// Health and performance metrics
    pub health: PoolHealth<BlockNumberFor<T>>,
}

/// Lightweight pool health tracking
pub struct PoolHealth<BlockNumber> {
    /// Exponentially weighted success rate
    pub success_rate: Permill,
    /// Average slippage (actual vs expected)
    pub avg_slippage: FixedU128,
    /// Optional governance pause horizon
    pub paused_until: Option<BlockNumber>,
}

/// Route allocation strategy
pub enum RouteMode {
    /// Single best route (default)
    Single,
    /// Split across multiple routes
    Split { max_routes: u8 },
}

/// System-wide configuration
pub struct SystemConfig<T: Config> {
    /// List of anchor assets
    pub anchors: BoundedVec<AssetId, T::MaxAnchors>,
    /// Fixed EMA smoothing coefficient
    pub ema_alpha: FixedU128,
    /// Minimum TVL for pool inclusion
    pub min_liquidity: Balance,
    /// EMA staleness threshold
    pub ema_ttl: BlockNumberFor<T>,
    /// Route allocation mode
    pub route_mode: RouteMode,
    /// Restrict to internal pools only
    pub internal_only: bool,
    /// Minimum acceptable success rate
    pub success_threshold: Permill,
    /// Maximum tolerated average slippage
    pub slippage_cap: Permill,
}

/// Route execution plan
pub enum Route {
    Direct {
        from: AssetId,
        to: AssetId
    },
    TwoHop {
        from: AssetId,
        via: AssetId,
        to: AssetId
    },
    Split {
        routes: BoundedVec<(Route, Permill), MaxSplits>,
    },
}
```

## 3. Token Oracle System

### 3.1 TVL-Weighted Price Aggregation

For token T at time t, aggregate price across all healthy pools weighted by TVL:

$$P_{agg}^T(t) = \frac{\sum_{i \in \mathcal{P}_T} TVL_i(t) \cdot P_i^T(t)}{\sum_{i \in \mathcal{P}_T} TVL_i(t)}$$

where:

- $\mathcal{P}_T$ = set of pools containing token T with $TVL_i \geq L_{min}$
- $P_i^T$ = marginal price of token T in pool i (quote/base or base/quote)
- Pool i included only if: `health.paused_until` is unset or expired and `last_activity + ema_ttl ≥ now`

### 3.2 Fixed Smoothing Coefficient

The EMA uses a single smoothing factor `ema_alpha` configured via governance. Typical values lie between 0.02 and 0.05, providing a balance between responsiveness and noise rejection without introducing state-dependent adjustments.

### 3.3 EMA Update Formula

Standard first-order exponential moving average with fixed α:

$$EMA_T(t) = (1 - \alpha) \cdot EMA_T(t-1) + \alpha \cdot P_{agg}^T(t)$$

### 3.4 Implementation

```rust
impl<T: Config> Pallet<T> {
    /// Update token EMA based on current pool states
    pub fn update_token_ema(
        token: AssetId
    ) -> Result<(), Error<T>> {
        let current_block = frame_system::Pallet::<T>::block_number();
        let pools = Self::get_active_pools_for_token(token)?;

        ensure!(!pools.is_empty(), Error::<T>::NoActivePools);

        // Calculate TVL-weighted price
        let mut weighted_sum = FixedU128::zero();
        let mut total_tvl = Balance::zero();

        for (pool_key, pool) in pools.iter() {
            // Skip unhealthy pools
            if !Self::is_pool_healthy(pool, current_block) {
                continue;
            }

            let price = Self::calculate_marginal_price(
                pool,
                token,
                pool_key.0,  // base
                pool_key.1   // quote
            )?;

            weighted_sum = weighted_sum
                .saturating_add(price.saturating_mul_int(pool.tvl));
            total_tvl = total_tvl.saturating_add(pool.tvl);
        }

        ensure!(
            total_tvl >= T::MinLiquidity::get(),
            Error::<T>::InsufficientTotalLiquidity
        );

        let aggregated_price = weighted_sum
            .checked_div(&FixedU128::from_inner(total_tvl))
            .ok_or(Error::<T>::MathOverflow)?;

        let config = RouterConfig::<T>::get();
        let alpha = config.ema_alpha;

        // Update or initialize EMA
        TokenOracles::<T>::try_mutate(token, |maybe_ema| {
            let ema = maybe_ema.get_or_insert_with(|| TokenEMA {
                ema_price: aggregated_price,
                last_price: aggregated_price,
                last_updated: current_block,
                total_liquidity: total_tvl,
                ttl: T::EmaMaxAge::get(),
            });

            ema.ema_price = ema.ema_price
                .saturating_mul(FixedU128::one().saturating_sub(alpha))
                .saturating_add(aggregated_price.saturating_mul(alpha));

            ema.last_price = aggregated_price;
            ema.total_liquidity = total_tvl;
            ema.last_updated = current_block;

            Ok(())
        })?;

        Self::deposit_event(Event::TokenEmaUpdated {
            token,
            price: aggregated_price,
        });

        Ok(())
    }


    /// Check if pool is healthy for routing
    fn is_pool_healthy(
        pool: &PoolInfo<T>,
        current_block: BlockNumberFor<T>
    ) -> bool {
        let config = RouterConfig::<T>::get();

        if let Some(paused_until) = pool.health.paused_until {
            if current_block < paused_until {
                return false;
            }
        }

        if pool.health.success_rate < config.success_threshold {
            return false;
        }

        if pool.health.avg_slippage > config.slippage_cap.into() {
            return false;
        }

        if current_block.saturating_sub(pool.last_activity) > config.ema_ttl {
            return false;
        }

        true
    }
}
```

## 4. Routing Algorithm

### 4.1 Route Discovery with Health Filtering

```rust
impl<T: Config> Pallet<T> {
    /// Find optimal route(s) based on configuration
    pub fn find_best_route(
        from: AssetId,
        to: AssetId,
        amount: Balance,
    ) -> Result<Route, Error<T>> {
        let config = RouterConfig::<T>::get();
        let current_block = frame_system::Pallet::<T>::block_number();

        // Case 1: Direct swap if one asset is anchor
        if Self::is_anchor(&from) || Self::is_anchor(&to) {
            if let Some(pool) = Pools::<T>::get(&from, &to) {
                if Self::is_pool_healthy(&pool, current_block) {
                    return Ok(Route::Direct { from, to });
                }
            }
        }

        // Case 2: Two-hop routing through anchors
        let anchors = config.anchors;
        ensure!(!anchors.is_empty(), Error::<T>::NoAnchorsConfigured);

        match config.route_mode {
            RouteMode::Single => {
                Self::find_single_best_route(from, to, amount, &anchors)
            },
            RouteMode::Split { max_routes } => {
                Self::find_split_routes(from, to, amount, &anchors, max_routes)
            },
        }
    }

    /// Find single best route through anchors
    fn find_single_best_route(
        from: AssetId,
        to: AssetId,
        amount: Balance,
        anchors: &BoundedVec<AssetId, T::MaxAnchors>,
    ) -> Result<Route, Error<T>> {
        let current_block = frame_system::Pallet::<T>::block_number();
        let mut best_route = None;
        let mut best_score = FixedU128::zero();

        for anchor in anchors.iter() {
            // Skip if same as from/to
            if anchor == &from || anchor == &to {
                continue;
            }

            // Get both pools
            let pool1 = Pools::<T>::get(&from, anchor);
            let pool2 = Pools::<T>::get(anchor, &to);

            if let (Some(p1), Some(p2)) = (pool1, pool2) {
                // Check health
                if !Self::is_pool_healthy(&p1, current_block)
                    || !Self::is_pool_healthy(&p2, current_block) {
                    continue;
                }

                // Calculate route score
                let score = Self::score_route(
                    &from,
                    anchor,
                    &to,
                    amount,
                    &p1,
                    &p2
                )?;

                if score > best_score {
                    best_score = score;
                    best_route = Some(Route::TwoHop {
                        from,
                        via: *anchor,
                        to,
                    });
                }
            }
        }

        best_route.ok_or(Error::<T>::NoRouteFound)
    }

    /// Find and allocate split routes (advanced feature)
    fn find_split_routes(
        from: AssetId,
        to: AssetId,
        amount: Balance,
        anchors: &BoundedVec<AssetId, T::MaxAnchors>,
        max_routes: u8,
    ) -> Result<Route, Error<T>> {
        let current_block = frame_system::Pallet::<T>::block_number();
        let mut scored_routes = Vec::new();

        // Collect all viable routes with scores
        for anchor in anchors.iter() {
            if anchor == &from || anchor == &to {
                continue;
            }

            let pool1 = Pools::<T>::get(&from, anchor);
            let pool2 = Pools::<T>::get(anchor, &to);

            if let (Some(p1), Some(p2)) = (pool1, pool2) {
                if !Self::is_pool_healthy(&p1, current_block)
                    || !Self::is_pool_healthy(&p2, current_block) {
                    continue;
                }

                let score = Self::score_route(
                    &from, anchor, &to, amount, &p1, &p2
                )?;

                scored_routes.push((
                    Route::TwoHop { from, via: *anchor, to },
                    score
                ));
            }
        }

        ensure!(!scored_routes.is_empty(), Error::<T>::NoRouteFound);

        // Sort by score descending
        scored_routes.sort_by(|a, b| b.1.cmp(&a.1));

        // Take top N routes
        let selected = scored_routes
            .into_iter()
            .take(max_routes as usize)
            .collect::<Vec<_>>();

        // Allocate proportionally to liquidity score
        let total_score: FixedU128 = selected.iter()
            .map(|(_, s)| *s)
            .fold(FixedU128::zero(), |acc, s| acc.saturating_add(s));

        let mut allocations = BoundedVec::new();
        for (route, score) in selected {
            let proportion = score
                .checked_div(&total_score)
                .unwrap_or_else(FixedU128::zero);

            allocations.try_push((
                route,
                Permill::from_rational(
                    proportion.into_inner() as u32,
                    FixedU128::one().into_inner() as u32
                )
            )).map_err(|_| Error::<T>::TooManyRoutes)?;
        }

        Ok(Route::Split { routes: allocations })
    }
}
```

### 4.2 Comprehensive Route Scoring

```rust
impl<T: Config> Pallet<T> {
    /// Score route based on expected output, liquidity, and health
    fn score_route(
        from: &AssetId,
        via: &AssetId,
        to: &AssetId,
        amount: Balance,
        pool1: &PoolInfo<T>,
        pool2: &PoolInfo<T>,
    ) -> Result<FixedU128, Error<T>> {
        // Simulate swap outputs
        let intermediate = Self::calculate_swap_output(
            pool1,
            amount,
            from,
            via
        )?;
        let final_output = Self::calculate_swap_output(
            pool2,
            intermediate,
            via,
            to
        )?;

        // Get fair value from EMAs
        let from_ema = TokenOracles::<T>::get(from)
            .ok_or(Error::<T>::OracleNotFound)?;
        let to_ema = TokenOracles::<T>::get(to)
            .ok_or(Error::<T>::OracleNotFound)?;

        let expected_fair_output = FixedU128::from_inner(amount)
            .saturating_mul(from_ema.ema_price)
            .checked_div(&to_ema.ema_price)
            .ok_or(Error::<T>::MathOverflow)?;

        // Price efficiency ratio
        let price_efficiency = FixedU128::from_inner(final_output)
            .checked_div(&expected_fair_output)
            .unwrap_or_else(FixedU128::zero);

        // Liquidity score (geometric mean of TVLs)
        let liquidity_score = {
            let product = (pool1.tvl as u128)
                .saturating_mul(pool2.tvl as u128);
            let sqrt = Self::integer_sqrt(product);
            FixedU128::from_inner(sqrt)
        };

        // Health penalty
        let health_penalty = Self::calculate_health_penalty(pool1, pool2)?;

        // Composite score
        let base_score = price_efficiency
            .saturating_mul(liquidity_score)
            .saturating_div(FixedU128::from_inner(1_000_000_000_000_000_000)); // Normalize

        Ok(base_score.saturating_sub(health_penalty))
    }

    /// Calculate health penalty based on pool metrics
    fn calculate_health_penalty(
        pool1: &PoolInfo<T>,
        pool2: &PoolInfo<T>,
    ) -> Result<FixedU128, Error<T>> {
        let config = RouterConfig::<T>::get();
        let max_parts = Permill::one().deconstruct() as u128;

        let mut penalty = FixedU128::zero();

        for pool in [pool1, pool2] {
            if pool.health.success_rate < config.success_threshold {
                let shortfall = (config.success_threshold.deconstruct() as u128)
                    .saturating_sub(pool.health.success_rate.deconstruct() as u128);
                let normalized = FixedU128::from_rational(shortfall, max_parts);
                penalty = penalty.saturating_add(normalized);
            }

            if pool.health.avg_slippage > config.slippage_cap.into() {
                let excess = pool.health.avg_slippage
                    .saturating_sub(config.slippage_cap.into());
                penalty = penalty.saturating_add(excess);
            }
        }

        Ok(penalty)
    }

    /// Integer square root (for liquidity score)
    fn integer_sqrt(n: u128) -> u128 {
        if n == 0 {
            return 0;
        }
        let mut x = n;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
    }
}
```

## 5. Swap Execution

### 5.1 Main Entry Point

```rust
#[pallet::call]
impl<T: Config> Pallet<T> {
    /// Execute swap with automatic routing
    #[pallet::weight(T::WeightInfo::swap())]
    #[pallet::call_index(0)]
    pub fn swap(
        origin: OriginFor<T>,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        min_amount_out: Balance,
        max_hops: Option<u8>,
    ) -> DispatchResult {
        let who = ensure_signed(origin)?;

        // Validate inputs
        ensure!(from != to, Error::<T>::IdenticalAssets);
        ensure!(amount_in > Balance::zero(), Error::<T>::ZeroAmount);

        // Find optimal route
        let route = Self::find_best_route(from, to, amount_in)?;

        // Validate hop count
        if let Some(max) = max_hops {
            let hops = Self::count_hops(&route);
            ensure!(hops <= max, Error::<T>::TooManyHops);
        }

        // Execute swap(s)
        let amount_out = Self::execute_route(&who, &route, amount_in)?;

        // Slippage protection
        ensure!(
            amount_out >= min_amount_out,
            Error::<T>::SlippageExceeded
        );

        // Update token EMAs
        Self::update_token_ema(from)?;
        Self::update_token_ema(to)?;

        Self::deposit_event(Event::SwapExecuted {
            who,
            from,
            to,
            amount_in,
            amount_out,
            route: Self::route_to_string(&route),
        });

        Ok(())
    }

    /// Emergency pause pool
    #[pallet::weight(T::WeightInfo::pause_pool())]
    #[pallet::call_index(1)]
    pub fn pause_pool(
        origin: OriginFor<T>,
        base: AssetId,
        quote: AssetId,
        duration: Option<BlockNumberFor<T>>,
    ) -> DispatchResult {
        ensure_root(origin)?;

        Pools::<T>::try_mutate(base, quote, |maybe_pool| {
            let pool = maybe_pool.as_mut()
                .ok_or(Error::<T>::PoolNotFound)?;

            let paused_until = duration
                .map(|d| frame_system::Pallet::<T>::block_number() + d);

            pool.health.paused_until = paused_until;

            Self::deposit_event(Event::PoolPaused {
                base,
                quote,
                until: paused_until,
            });

            Ok(())
        })
    }

    /// Reset token EMA (governance only)
    #[pallet::weight(T::WeightInfo::reset_ema())]
    #[pallet::call_index(2)]
    pub fn reset_token_ema(
        origin: OriginFor<T>,
        token: AssetId,
        new_price: FixedU128,
    ) -> DispatchResult {
        ensure_root(origin)?;

        TokenOracles::<T>::try_mutate(token, |maybe_ema| {
            let ema = maybe_ema.as_mut()
                .ok_or(Error::<T>::OracleNotFound)?;

            ema.ema_price = new_price;
            ema.last_price = new_price;
            ema.last_updated = frame_system::Pallet::<T>::block_number();

            Self::deposit_event(Event::EmaReset {
                token,
                new_price,
            });

            Ok(())
        })
    }
}
```

### 5.2 Route Execution with Atomicity

```rust
impl<T: Config> Pallet<T> {
    /// Execute route atomically
    fn execute_route(
        who: &T::AccountId,
        route: &Route,
        amount_in: Balance,
    ) -> Result<Balance, Error<T>> {
        match route {
            Route::Direct { from, to } => {
                Self::execute_single_swap(who, *from, *to, amount_in)
            },
            Route::TwoHop { from, via, to } => {
                let intermediate = Self::execute_single_swap(
                    who, *from, *via, amount_in
                )?;
                Self::execute_single_swap(who, *via, *to, intermediate)
            },
            Route::Split { routes } => {
                let mut total_out = Balance::zero();

                for (sub_route, proportion) in routes.iter() {
                    let allocated_amount = proportion.mul_floor(amount_in);
                    let sub_output = Self::execute_route(
                        who,
                        sub_route,
                        allocated_amount
                    )?;
                    total_out = total_out.saturating_add(sub_output);
                }

                Ok(total_out)
            },
        }
    }

    /// Execute single pool swap with health tracking
    fn execute_single_swap(
        who: &T::AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
    ) -> Result<Balance, Error<T>> {
        let current_block = frame_system::Pallet::<T>::block_number();

        Pools::<T>::try_mutate(&from, &to, |maybe_pool| {
            let pool = maybe_pool.as_mut()
                .ok_or(Error::<T>::PoolNotFound)?;

            // Calculate expected output
            let expected_out = Self::calculate_swap_output(
                pool,
                amount_in,
                &from,
                &to
            )?;

            // Execute via pool adapter
            let actual_out = Self::adapter_swap(
                pool,
                who,
                from,
                to,
                amount_in
            )?;

            // Calculate slippage
            let slippage = if expected_out > Balance::zero() {
                let diff = expected_out.saturating_sub(actual_out);
                FixedU128::from_rational(diff, expected_out)
            } else {
                FixedU128::zero()
            };

            // Update pool health
            let success = actual_out > Balance::zero();
            Self::update_pool_health(pool, success, slippage, current_block)?;

            // Update pool state
            pool.last_activity = current_block;
            Self::recalculate_pool_tvl(pool, from, to)?;

            Ok(actual_out)
        })
    }

    /// Update pool reserves and TVL after swap
    fn recalculate_pool_tvl(
        pool: &mut PoolInfo<T>,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(), Error<T>> {
        // Get fresh reserves from adapter
        let (reserve_base, reserve_quote) = Self::adapter_get_reserves(
            &pool.pool_id,
            base,
            quote
        )?;

        pool.reserve_base = reserve_base;
        pool.reserve_quote = reserve_quote;

        // Calculate TVL using token EMAs
        let base_ema = TokenOracles::<T>::get(base)
            .ok_or(Error::<T>::OracleNotFound)?;
        let quote_ema = TokenOracles::<T>::get(quote)
            .ok_or(Error::<T>::OracleNotFound)?;

        let base_value = base_ema.ema_price.saturating_mul_int(reserve_base);
        let quote_value = quote_ema.ema_price.saturating_mul_int(reserve_quote);

        pool.tvl = base_value.saturating_add(quote_value);

        Ok(())
    }
}
```

## 5.3 Pool Health Management

```rust
impl<T: Config> Pallet<T> {
    /// Update pool health metrics after swap attempt
    fn update_pool_health(
        pool: &mut PoolInfo<T>,
        success: bool,
        slippage: FixedU128,
        _current_block: BlockNumberFor<T>,
    ) -> Result<(), Error<T>> {
        let one = Permill::one().deconstruct() as u64;
        let current = pool.health.success_rate.deconstruct() as u64;

        if success {
            let new_rate = ((current * 95) + (one * 5)) / 100;
            pool.health.success_rate = Permill::from_parts(new_rate.min(one) as u32);

            pool.health.avg_slippage = pool.health.avg_slippage
                .saturating_mul(FixedU128::from_rational(95, 100))
                .saturating_add(slippage.saturating_mul(FixedU128::from_rational(5, 100)));
        } else {
            let new_rate = (current * 90) / 100;
            pool.health.success_rate = Permill::from_parts(new_rate as u32);

            let penalty = if slippage > FixedU128::zero() {
                slippage
            } else {
                FixedU128::one()
            };

            pool.health.avg_slippage = pool.health.avg_slippage
                .saturating_mul(FixedU128::from_rational(9, 10))
                .saturating_add(penalty.saturating_mul(FixedU128::from_rational(1, 10)));
        }

        Ok(())
    }
}
```

## 6. Security & Safety Guarantees

### 6.1 System Invariants

| Invariant             | Description                        | Enforcement                        |
| --------------------- | ---------------------------------- | ---------------------------------- |
| **Route Determinism** | Identical state → identical route  | Pure functions, no randomness      |
| **Price Coherence**   | `EMA - Spot < 50%` over window     | Fixed α EMA + TVL weighting        |
| **Complexity Bound**  | Max 2 hops per swap                | Hard-coded in route discovery      |
| **Liquidity Minimum** | `TVL ≥ MinLiquidity` for inclusion | Pre-filter in aggregation          |
| **Atomicity**         | All-or-nothing execution           | Transaction rollback on failure    |
| **Health Thresholds** | Pools below thresholds excluded    | Success/slippage checks in routing |

### 6.2 MEV Resistance Mechanisms

- **EMA-based pricing**: Single-block manipulation cannot significantly move token price
- **TVL weighting**: Requires deep liquidity control across multiple pools
- **Health thresholds**: Pools breaching success/slippage limits are excluded from routing
- **Slippage protection**: User-specified `min_amount_out` enforced
- **Deterministic routing**: No transaction ordering advantages
- **Fixed smoothing**: Stable α prevents single-block price spikes from dominating EMA

**Optional Enhancement**: VRF-based transaction ordering at consensus level for additional protection.

### 6.3 Attack Surface Analysis

| Attack Vector       | Mitigation                         | Residual Risk                    |
| ------------------- | ---------------------------------- | -------------------------------- |
| Oracle manipulation | TVL-weighted aggregation           | Requires >50% liquidity control  |
| Front-running       | EMA prices + slippage limits       | Limited to slippage tolerance    |
| Pool draining       | Minimum liquidity checks           | None if enforced                 |
| Spam swaps          | Weight limits + fees               | Economic deterrent               |
| Health gaming       | Threshold-based exclusion          | Low, requires sustained failures |
| Stale data          | TTL enforcement + offchain workers | Minor if workers fail            |

### 6.4 Emergency Controls

```rust
#[pallet::call]
impl<T: Config> Pallet<T> {
    /// Global circuit breaker
    #[pallet::weight(T::WeightInfo::emergency_pause())]
    #[pallet::call_index(10)]
    pub fn emergency_pause(
        origin: OriginFor<T>,
    ) -> DispatchResult {
        T::EmergencyOrigin::ensure_origin(origin)?;

        RouterConfig::<T>::mutate(|config| {
            // Disable all routing temporarily
            config.route_mode = RouteMode::Single;

            // Pause all pools
            for ((base, quote), mut pool) in Pools::<T>::iter() {
                pool.health.paused_until = Some(BlockNumberFor::<T>::max_value());
                Pools::<T>::insert(base, quote, pool);
            }
        });

        Self::deposit_event(Event::EmergencyPause);
        Ok(())
    }

    /// Resume operations after emergency
    #[pallet::weight(T::WeightInfo::emergency_resume())]
    #[pallet::call_index(11)]
    pub fn emergency_resume(
        origin: OriginFor<T>,
        pools: Vec<(AssetId, AssetId)>,
    ) -> DispatchResult {
        T::EmergencyOrigin::ensure_origin(origin)?;

        for (base, quote) in pools {
            Pools::<T>::try_mutate(base, quote, |maybe_pool| {
                if let Some(pool) = maybe_pool {
                    pool.health.paused_until = None;
                }
            });
        }

        Self::deposit_event(Event::EmergencyResume {
            pools_count: pools.len() as u32,
        });
        Ok(())
    }

    /// Force EMA recalculation
    #[pallet::weight(T::WeightInfo::force_ema_update())]
    #[pallet::call_index(12)]
    pub fn force_ema_update(
        origin: OriginFor<T>,
        tokens: Vec<AssetId>,
    ) -> DispatchResult {
        ensure_root(origin)?;

        for token in tokens {
            Self::update_token_ema(token)?;
        }

        Ok(())
    }
}
```

## 7. Configuration & Tuning

### 7.1 Parameter Reference

| Parameter           | Default      | Range     | Impact                        | Tuning Guidance             |
| ------------------- | ------------ | --------- | ----------------------------- | --------------------------- |
| `MaxAnchors`        | 6            | 3-12      | Routing options vs complexity | Start conservative (3-5)    |
| `ema_alpha`         | 0.03         | 0.01-0.05 | EMA responsiveness            | Lower = more smoothing      |
| `min_liquidity`     | 10,000 units | >0        | Pool inclusion threshold      | Set per token value         |
| `ema_ttl`           | 30 blocks    | 10-120    | Data staleness limit          | ~2-3 minutes recommended    |
| `success_threshold` | 70%          | 50-90%    | Minimum health requirement    | Raise for stricter routing  |
| `slippage_cap`      | 5%           | 1-20%     | Acceptable average slippage   | Higher for volatile markets |
| `route_mode`        | `Single`     | -         | Performance vs optimization   | Use `Single` initially      |
| `internal_only`     | `true`       | bool      | External pool access          | Disable until audited       |

### 7.2 Per-Token Overrides

```rust
#[pallet::storage]
pub type TokenConfig<T: Config> = StorageMap<
    _,
    Blake2_128Concat,
    AssetId,
    TokenConfigOverride
>;

pub struct TokenConfigOverride {
    pub min_liquidity: Option<Balance>,
    pub ema_alpha: Option<FixedU128>,
    pub ema_ttl: Option<BlockNumber>,
}
```

### 7.3 Runtime Configuration Example

```rust
impl pallet_axial_router::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type Assets = Assets;
    type MaxAnchors = ConstU32<6>;
    type MinLiquidity = ConstU128<10_000_000_000_000>; // 10k units
    type EmaMaxAge = ConstU32<30>; // 30 blocks
    type EmergencyOrigin = EnsureRootOrHalfCouncil;
    type WeightInfo = weights::SubstrateWeight<Runtime>;
}

// Initialize via governance
#[test]
fn initialize_router() {
    let config = SystemConfig {
        anchors: vec![NATIVE, DOT, USDC].try_into().unwrap(),
        ema_alpha: FixedU128::from_rational(3, 100), // 0.03
        min_liquidity: 10_000,
        ema_ttl: 30,
        route_mode: RouteMode::Single,
        internal_only: true,
        success_threshold: Permill::from_percent(70),
        slippage_cap: Permill::from_percent(5),
    };

    RouterConfig::<Runtime>::put(config);
}
```

## 8. Protocol-Owned Liquidity (POL) Integration

### 8.1 Design Philosophy

POL participates as **standard liquidity provider** without special privileges:

- POL tokens locked in pool reserves like any LP
- TVL calculations include POL shares naturally
- No separate routing logic or priority
- POL rewards distributed per standard LP mechanics
- Health metrics apply equally to POL and user liquidity

### 8.2 Implementation

```rust
/// POL is tracked at pool adapter level, not router
pub trait PoolAdapter<AccountId, AssetId, Balance> {
    /// Get total reserves (includes POL + user LP)
    fn get_reserves(
        pool_id: PoolId,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(Balance, Balance), Error>;

    /// Execute swap (POL transparent to execution)
    fn swap(
        pool_id: PoolId,
        who: &AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
    ) -> Result<Balance, Error>;

    /// Query POL share (for telemetry only)
    fn pol_share(
        pool_id: PoolId,
    ) -> Option<Permill>;
}
```

### 8.3 POL Considerations

- **Liquidity depth**: POL increases effective TVL for routing
- **Price stability**: Protocol can provide countercyclical liquidity
- **Risk management**: POL subject to impermanent loss like any LP
- **Governance**: POL allocation decisions outside router scope

## 9. Testing Requirements

### 9.1 Unit Test Coverage

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_calculation_accuracy() {
        // Verify TVL-weighted aggregation
        // Confirm fixed alpha smoothing
        // Ensure initialization path is correct
    }

    #[test]
    fn route_scoring_determinism() {
        // Same inputs → same outputs
        // Verify score ordering
        // Test edge cases (zero liquidity, anchor overlap)
    }

    #[test]
    fn health_state_transitions() {
        // Success → improve success_rate
        // Failure → degrade success_rate
        // Slippage smoothing behaves as expected
    }

    #[test]
    fn slippage_protection() {
        // Reject swaps below min_amount_out
        // Flag pools exceeding slippage_cap
        // Verify calculation accuracy
    }

    #[test]
    fn liquidity_filtering() {
        // Exclude pools below MinLiquidity
        // Handle zero TVL gracefully
        // Test per-token overrides
    }

    #[test]
    fn ttl_enforcement() {
        // Stale EMA excluded from routing
        // Offchain worker triggers
        // Manual force update
    }
}
```

### 9.2 Integration Tests

```rust
#[cfg(test)]
mod integration {
    #[test]
    fn multi_hop_optimality() {
        // Compare direct vs two-hop routes
        // Verify best route selection
        // Test split mode allocation
    }

    #[test]
    fn atomic_execution() {
        // Failure mid-route → full rollback
        // No partial state changes
        // Event emission consistency
    }

    #[test]
    fn pool_lifecycle() {
        // Normal operation
        // Failure → health threshold breach
        // Recovery → metrics rebound above thresholds
        // Emergency pause/resume
    }

    #[test]
    fn ema_convergence() {
        // Price shock scenario
        // Verify convergence rate
        // Validate sensitivity to alpha setting
    }

    #[test]
    fn pol_participation() {
        // POL reserves counted in TVL
        // No routing preference
        // Equal health treatment
    }
}
```

### 9.3 Stress & Benchmark Tests

```rust
#[cfg(feature = "runtime-benchmarks")]
mod benchmarks {
    use frame_benchmarking::*;

    benchmarks! {
        swap_direct {
            let amount = 1_000_000u128;
        }: swap(Origin::signed(caller), ASSET_A, ASSET_B, amount, 0, None)

        swap_two_hop {
            let amount = 1_000_000u128;
        }: swap(Origin::signed(caller), ASSET_A, ASSET_C, amount, 0, None)

        update_ema {
            let n in 1 .. 10; // number of pools
        }: update_token_ema(ASSET_A)

        find_route {
            let a in 3 .. 10; // number of anchors
        }: find_best_route(ASSET_A, ASSET_B, 1_000_000)
    }

    #[test]
    fn test_500_tokens() {
        // Verify performance at scale
        // Max 500 tokens, 10 anchors
        // All operations < 200k weight
    }

    #[test]
    fn price_shock_resilience() {
        // ±50% instant price change
        // System remains stable
        // No oracle manipulation
    }

    #[test]
    fn mass_pool_failures() {
        // 50% of pools fail simultaneously
        // Routing continues via healthy pools
        // Recovery once pools meet thresholds again
    }
}
```

## 10. Monitoring & Operations

### 10.1 Telemetry Integration

```rust
impl<T: Config> Pallet<T> {
    fn emit_telemetry(&self, event: &str, data: Vec<(&str, String)>) {
        telemetry!(
            CONSENSUS_INFO;
            "axial_router.{}",
            event;
            data.iter().map(|(k, v)| format!("{} => {}", k, v))
        );
    }
}

// Example usage
Self::emit_telemetry("swap_executed", vec![
    ("from", format!("{:?}", from)),
    ("to", format!("{:?}", to)),
    ("amount", amount.to_string()),
    ("route", route_type),
    ("slippage_bps", (slippage * 10000).to_string()),
]);
```

### 10.2 Prometheus Metrics

```rust
// Exposed metrics
- axial_router_swaps_total{route_type, success}
- axial_router_route_score{from, via, to}
- axial_router_token_ema_price{token}
- axial_router_pool_tvl{base, quote}
- axial_router_pool_success_rate{pool_id}
- axial_router_pool_avg_slippage{pool_id}
- axial_router_ema_staleness_blocks{token}
```

### 10.3 Operational Alerts

| Alert Condition                    | Severity | Recommended Action              |
| ---------------------------------- | -------- | ------------------------------- |
| `total_tvl < MinLiquidity`         | Critical | Investigate liquidity drain     |
| `success_rate < success_threshold` | Critical | Check pool adapter health       |
| `avg_slippage > slippage_cap`      | Warning  | Engage LPs or adjust thresholds |
| `staleness > ema_ttl`              | Warning  | Verify offchain workers         |
| `emergency_pause`                  | Critical | Incident response               |

### 10.4 Offchain Workers

```rust
#[pallet::hooks]
impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
    fn offchain_worker(block_number: BlockNumberFor<T>) {
        // Update stale EMAs
        let stale_tokens = Self::find_stale_emas(block_number);
        for token in stale_tokens {
            if let Err(e) = Self::update_token_ema(token) {
                log::warn!("Offchain EMA update failed: {:?}", e);
            }
        }

        // Emit health snapshot
        Self::emit_health_snapshot(block_number);
    }
}
```

## 11. Migration & Upgrade Path

### 11.1 From Existing DEX

```rust
/// Phase 1: Deploy parallel (0 risk)
#[pallet::genesis_config]
pub struct GenesisConfig {
    pub import_pools: Vec<(AssetId, AssetId, Balance, Balance)>,
    pub initial_anchors: Vec<AssetId>,
    pub config: SystemConfig,
}

#[pallet::genesis_build]
impl<T: Config> GenesisBuild<T> for GenesisConfig {
    fn build(&self) {
        // Import existing pools
        for (base, quote, reserve_b, reserve_q) in &self.import_pools {
            let pool = PoolInfo {
                pool_id: Self::generate_pool_id(*base, *quote),
                reserve_base: *reserve_b,
                reserve_quote: *reserve_q,
                tvl: Balance::zero(), // Calculate after EMAs
                last_activity: frame_system::Pallet::<T>::block_number(),
                health: PoolHealth::default(),
            };
            Pools::<T>::insert(base, quote, pool);
        }

        // Initialize EMAs from spot prices
        for (base, quote, reserve_b, reserve_q) in &self.import_pools {
            let spot_price = FixedU128::from_rational(*reserve_q, *reserve_b);
            TokenOracles::<T>::insert(*base, TokenEMA {
                ema_price: spot_price,
                last_price: spot_price,
                last_updated: frame_system::Pallet::<T>::block_number(),
                total_liquidity: *reserve_b,
                ttl: T::EmaMaxAge::get(),
            });
        }

        // Set configuration
        RouterConfig::<T>::put(self.config.clone());
        Anchors::<T>::put(self.initial_anchors.clone().try_into().unwrap());
    }
}

/// Phase 2: Parallel operation (low risk)
// Run both systems, compare outputs, monitor divergence

/// Phase 3: Gradual migration (managed risk)
pub fn migrate_routing_percentage(pct: Permill) -> Weight {
    // Route {pct}% through Axial, rest through legacy
    // Governance-controlled ramp-up
}

/// Phase 4: Full cutover (post-validation)
pub fn finalize_migration() -> DispatchResult {
    ensure_root(origin)?;
    // Disable legacy router
    // Route 100% through Axial
    Ok(())
}
```

### 11.2 Storage Migrations

```rust
pub mod v2 {
    use super::*;

    pub fn migrate<T: Config>() -> Weight {
        let version = StorageVersion::get::<Pallet<T>>();

        if version < 2 {
            log::info!("Migrating AxialRouter to v2...");

            // Add new health fields
            Pools::<T>::translate(|_base, _quote, old: PoolInfoV1<T>| {
                Some(PoolInfo {
                    pool_id: old.pool_id,
                    reserve_base: old.reserve_base,
                    reserve_quote: old.reserve_quote,
                    tvl: old.tvl,
                    last_activity: old.last_activity,
                    health: PoolHealth {
                        success_rate: old.success_rate,
                        avg_slippage: FixedU128::zero(),
                        paused_until: None,
                    },
                })
            });

            StorageVersion::new(2).put::<Pallet<T>>();
            log::info!("Migration complete");
        }

        T::DbWeight::get().reads_writes(1, 1)
    }
}
```

## 12. Future Enhancements

### 12.1 Near-Term (Next 6 Months)

- [ ] **VRF-based transaction ordering**: Integrate with consensus for MEV resistance
- [ ] **Cross-chain anchors**: XCM-based external pool support
- [ ] **Advanced telemetry**: Grafana dashboards and alerting
- [ ] **Liquidity incentives**: Reward underutilized routing paths
- [ ] **Gas optimization**: Further weight reduction via batch operations

### 12.2 Medium-Term (6-12 Months)

- [ ] **Concentrated liquidity**: Uniswap V3-style range orders
- [ ] **Intent-based routing**: Match user intents with optimal paths
- [ ] **Machine learning**: Predictive health scoring
- [ ] **Multi-asset swaps**: Single transaction for complex trades
- [ ] **Privacy features**: zk-proofs for swap amounts

### 12.3 Research Topics

- **Automated market maker hybrids**: Combine XYK with order books
- **Cross-domain MEV protection**: Parachain-level coordination
- **Adaptive fee structures**: Dynamic fees based on observed flow
- **Decentralized oracle networks**: External price feed integration
- **Game-theoretic security**: Formal verification of incentive alignment

## 13. Compliance & Auditing

### 13.1 Audit Checklist

- [ ] Mathematical correctness of EMA calculations
- [ ] Overflow/underflow protection in all arithmetic
- [ ] Reentrancy guards on external calls
- [ ] Access control for privileged functions
- [ ] Storage layout for upgrade safety
- [ ] Weight calculations accuracy
- [ ] Economic attack vectors
- [ ] Edge case handling (zero amounts, identical assets, etc.)

### 13.2 Formal Verification Targets

```rust
// Invariants to prove:
// 1. Conservation of value: Σ(inputs) ≥ Σ(outputs) + fees
// 2. Price bounds: EMA within [spot * 0.5, spot * 1.5]
// 3. Complexity bound: route_hops(any_swap) ≤ 2
// 4. Health monotonicity: consecutive success → health improvement
```

## Appendix A: Mathematical Proofs

### A.1 EMA Convergence

**Theorem**: Given stable aggregated price $P_0$, the EMA converges to $P_0$ exponentially.

**Proof**: Let $\epsilon_t = |EMA_t - P_0|$. Then:

$\epsilon_{t+1} = |(1-\alpha)EMA_t + \alpha P_0 - P_0|$
$= |(1-\alpha)(EMA_t - P_0)|$
$= (1-\alpha)\epsilon_t$

Thus $\epsilon_t = (1-\alpha)^t \epsilon_0 \to 0$ as $t \to \infty$. $\square$

### A.2 Routing Complexity

**Theorem**: For $A$ anchors and $T$ tokens, worst-case routing complexity is $O(A)$.

**Proof**: Route discovery iterates over anchors (at most $A$), performs constant-time pool lookups and scoring. No nested loops over tokens. Total operations: $O(A \cdot C) = O(A)$ where $C$ is constant per anchor. $\square$

## Appendix B: Complete API Reference

### B.1 Extrinsics

```rust
// Core trading operations
pub fn swap(
    origin: OriginFor<T>,
    from: AssetId,
    to: AssetId,
    amount_in: Balance,
    min_amount_out: Balance,
    max_hops: Option<u8>,
) -> DispatchResult;

pub fn swap_exact_out(
    origin: OriginFor<T>,
    from: AssetId,
    to: AssetId,
    amount_out: Balance,
    max_amount_in: Balance,
) -> DispatchResult;

// Anchor management (governance)
pub fn add_anchor(
    origin: OriginFor<T>,
    asset: AssetId,
) -> DispatchResult;

pub fn remove_anchor(
    origin: OriginFor<T>,
    asset: AssetId,
) -> DispatchResult;

// Pool management
pub fn pause_pool(
    origin: OriginFor<T>,
    base: AssetId,
    quote: AssetId,
    duration: Option<BlockNumberFor<T>>,
) -> DispatchResult;

pub fn resume_pool(
    origin: OriginFor<T>,
    base: AssetId,
    quote: AssetId,
) -> DispatchResult;

// Oracle management
pub fn reset_token_ema(
    origin: OriginFor<T>,
    token: AssetId,
    new_price: FixedU128,
) -> DispatchResult;

pub fn force_ema_update(
    origin: OriginFor<T>,
    tokens: Vec<AssetId>,
) -> DispatchResult;

// Configuration updates
pub fn update_config(
    origin: OriginFor<T>,
    new_config: SystemConfig<T>,
) -> DispatchResult;

pub fn set_token_override(
    origin: OriginFor<T>,
    token: AssetId,
    override_config: TokenConfigOverride,
) -> DispatchResult;

// Emergency controls
pub fn emergency_pause(
    origin: OriginFor<T>,
) -> DispatchResult;

pub fn emergency_resume(
    origin: OriginFor<T>,
    pools: Vec<(AssetId, AssetId)>,
) -> DispatchResult;
```

### B.2 RPC Methods

```rust
// Price queries
pub fn get_token_price(token: AssetId) -> Option<FixedU128>;

// Route simulation
pub fn quote_exact_in(
    from: AssetId,
    to: AssetId,
    amount_in: Balance,
) -> Result<QuoteResult, Error>;

pub fn quote_exact_out(
    from: AssetId,
    to: AssetId,
    amount_out: Balance,
) -> Result<QuoteResult, Error>;

pub struct QuoteResult {
    pub amount: Balance,
    pub route: Route,
    pub expected_slippage: FixedU128,
    pub price_impact: FixedU128,
}

// Health monitoring
pub fn get_pool_health(
    base: AssetId,
    quote: AssetId,
) -> Option<PoolHealth>;

pub fn get_healthy_pools() -> Vec<(AssetId, AssetId, PoolInfo)>;

// Analytics
pub fn get_volume_24h(token: AssetId) -> Balance;
pub fn get_tvl_snapshot() -> Vec<(AssetId, Balance)>;
```

### B.3 Events

```rust
#[pallet::event]
#[pallet::generate_deposit(pub(super) fn deposit_event)]
pub enum Event<T: Config> {
    /// Swap executed successfully
    SwapExecuted {
        who: T::AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        amount_out: Balance,
        route: BoundedVec<u8, ConstU32<128>>,
    },

    /// Token EMA updated
    TokenEmaUpdated {
        token: AssetId,
        price: FixedU128,
    },

    /// Pool paused by governance
    PoolPaused {
        base: AssetId,
        quote: AssetId,
        until: Option<BlockNumber>,
    },

    /// Pool resumed
    PoolResumed {
        base: AssetId,
        quote: AssetId,
    },

    /// Anchor added
    AnchorAdded {
        asset: AssetId,
    },

    /// Anchor removed
    AnchorRemoved {
        asset: AssetId,
    },

    /// EMA manually reset
    EmaReset {
        token: AssetId,
        new_price: FixedU128,
    },

    /// Configuration updated
    ConfigUpdated {
        field: BoundedVec<u8, ConstU32<32>>,
    },

    /// Emergency pause activated
    EmergencyPause,

    /// Operations resumed after emergency
    EmergencyResume {
        pools_count: u32,
    },

    /// Route evaluation completed
    RouteEvaluated {
        from: AssetId,
        to: AssetId,
        best_score: FixedU128,
        routes_considered: u8,
    },
}
```

### B.4 Errors

```rust
#[pallet::error]
pub enum Error<T> {
    /// Assets are identical
    IdenticalAssets,
    /// Amount is zero
    ZeroAmount,
    /// Pool does not exist
    PoolNotFound,
    /// No oracle data for token
    OracleNotFound,
    /// Insufficient liquidity in pool
    InsufficientLiquidity,
    /// Insufficient total liquidity across pools
    InsufficientTotalLiquidity,
    /// No route found between assets
    NoRouteFound,
    /// Slippage tolerance exceeded
    SlippageExceeded,
    /// Too many hops in route
    TooManyHops,
    /// No anchors configured
    NoAnchorsConfigured,
    /// Maximum anchors reached
    TooManyAnchors,
    /// No active pools for token
    NoActivePools,
    /// Mathematical overflow
    MathOverflow,
    /// Pool adapter error
    AdapterError,
    /// EMA data is stale
    StaleEma,
    /// Too many routes for split mode
    TooManyRoutes,
    /// Invalid configuration
    InvalidConfig,
    /// Token override not found
    OverrideNotFound,
}
```

## Appendix C: Pool Adapter Interface

```rust
/// Trait for integrating different pool types
pub trait PoolAdapter<AccountId, AssetId, Balance> {
    type Error: Into<Error>;

    /// Get current reserves
    fn get_reserves(
        pool_id: PoolId,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(Balance, Balance), Self::Error>;

    /// Calculate expected output for exact input
    fn quote_exact_in(
        pool_id: PoolId,
        amount_in: Balance,
        from: AssetId,
        to: AssetId,
    ) -> Result<Balance, Self::Error>;

    /// Calculate required input for exact output
    fn quote_exact_out(
        pool_id: PoolId,
        amount_out: Balance,
        from: AssetId,
        to: AssetId,
    ) -> Result<Balance, Self::Error>;

    /// Execute swap
    fn swap(
        pool_id: PoolId,
        who: &AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        min_amount_out: Balance,
    ) -> Result<Balance, Self::Error>;

    /// Get pool type identifier
    fn pool_type(pool_id: PoolId) -> PoolType;

    /// Query protocol-owned liquidity share (optional)
    fn pol_share(pool_id: PoolId) -> Option<Permill> {
        None
    }

    /// Check if pool accepts external swaps
    fn is_external(pool_id: PoolId) -> bool {
        false
    }
}

pub enum PoolType {
    XYK,
    UTBC,
    External(BoundedVec<u8, ConstU32<32>>),
}

/// XYK constant product pool adapter
pub struct XykAdapter;

impl<AccountId, AssetId, Balance> PoolAdapter<AccountId, AssetId, Balance>
    for XykAdapter
{
    type Error = XykError;

    fn get_reserves(
        pool_id: PoolId,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(Balance, Balance), Self::Error> {
        // Query XYK pallet
        pallet_xyk::Pools::<T>::get(base, quote)
            .map(|p| (p.reserve_base, p.reserve_quote))
            .ok_or(XykError::PoolNotFound)
    }

    fn quote_exact_in(
        pool_id: PoolId,
        amount_in: Balance,
        from: AssetId,
        to: AssetId,
    ) -> Result<Balance, Self::Error> {
        let (reserve_in, reserve_out) = Self::get_reserves(pool_id, from, to)?;

        // XYK formula: out = (in * 997 * reserve_out) / (reserve_in * 1000 + in * 997)
        let amount_in_with_fee = amount_in.saturating_mul(997);
        let numerator = amount_in_with_fee.saturating_mul(reserve_out);
        let denominator = reserve_in
            .saturating_mul(1000)
            .saturating_add(amount_in_with_fee);

        Ok(numerator / denominator)
    }

    fn swap(
        pool_id: PoolId,
        who: &AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        min_amount_out: Balance,
    ) -> Result<Balance, Self::Error> {
        pallet_xyk::Pallet::<T>::swap(
            who.clone(),
            from,
            to,
            amount_in,
            min_amount_out,
        )
    }

    fn pool_type(_pool_id: PoolId) -> PoolType {
        PoolType::XYK
    }
}
```

## Appendix D: Deployment Checklist

### D.1 Pre-Deployment

- [ ] **Code Audit**: Complete security audit by reputable firm
- [ ] **Formal Verification**: Key invariants proven
- [ ] **Testnet Deployment**: At least 3 months on testnet
- [ ] **Load Testing**: Verified performance at target scale
- [ ] **Documentation**: All public interfaces documented
- [ ] **Governance Framework**: Clear parameter adjustment process
- [ ] **Emergency Procedures**: Incident response plan documented
- [ ] **Monitoring Setup**: Prometheus + Grafana dashboards
- [ ] **Alerting Configuration**: PagerDuty/Slack integration

### D.2 Launch Sequence

**Phase 0: Genesis (Block 0)**

```rust
// Initialize with conservative settings
GenesisConfig {
    import_pools: existing_dex_pools,
    initial_anchors: vec![NATIVE],  // Single anchor initially
    config: SystemConfig {
        ema_alpha: FixedU128::from_rational(1, 100), // 0.01 (very smooth)
        min_liquidity: 50_000,  // High threshold
        ema_ttl: 30,
        route_mode: RouteMode::Single,
        internal_only: true,
        success_threshold: Permill::from_percent(70),
        slippage_cap: Permill::from_percent(5),
    },
}
```

**Phase 1: Observation (Weeks 1-2)**

- Monitor EMA convergence
- Verify health metrics
- Compare with legacy router outputs
- No live trading yet

**Phase 2: Limited Trading (Weeks 3-4)**

- Enable swaps for whitelisted accounts
- Cap daily volume at 5% of TVL
- 24/7 monitoring with on-call team

**Phase 3: Gradual Rollout (Weeks 5-8)**

- Increase volume caps by 10% weekly
- Add second anchor (DOT or stablecoin)
- Enable public access with rate limits

**Phase 4: Full Production (Week 9+)**

- Remove rate limits
- Add remaining anchors
- Consider enabling Split mode
- Evaluate external pool integration

### D.3 Post-Deployment

- [ ] **Week 1 Review**: Analyze all metrics, identify issues
- [ ] **Month 1 Audit**: External review of live system behavior
- [ ] **Quarter 1 Optimization**: Parameter tuning based on data
- [ ] **Ongoing Monitoring**: Continuous improvement process

## Appendix E: Troubleshooting Guide

### E.1 Common Issues

| Symptom                      | Possible Cause                | Solution                                 |
| ---------------------------- | ----------------------------- | ---------------------------------------- |
| High EMA divergence          | Insufficient liquidity        | Increase `min_liquidity` threshold       |
| Routes always via one anchor | Unbalanced anchor liquidity   | Add/rebalance pools for other anchors    |
| Frequent threshold breaches  | Pools too small for volume    | Increase pool reserves or reduce traffic |
| Stale EMA warnings           | Offchain worker issues        | Check worker configuration and logs      |
| No routes found              | All pools unhealthy           | Emergency resume healthy pools           |
| High slippage                | Low liquidity or large trades | Split large orders or add liquidity      |

### E.2 Debug Procedures

```rust
// Check system state
pub fn debug_token(token: AssetId) -> TokenDebugInfo {
    let ema = TokenOracles::<T>::get(token);
    let pools = Self::get_pools_for_token(token);
    let active_pools = pools.iter()
        .filter(|p| Self::is_pool_healthy(p, current_block()))
        .count();

    TokenDebugInfo {
        ema,
        total_pools: pools.len(),
        active_pools,
        total_tvl: pools.iter().map(|p| p.tvl).sum(),
    }
}

// Simulate route without execution
pub fn dry_run_swap(
    from: AssetId,
    to: AssetId,
    amount: Balance,
) -> Result<DryRunResult, Error> {
    let route = Self::find_best_route(from, to, amount)?;
    let expected_out = Self::simulate_route_output(&route, amount)?;

    Ok(DryRunResult {
        route,
        expected_output: expected_out,
        estimated_slippage: Self::calculate_expected_slippage(&route, amount)?,
        gas_estimate: Self::estimate_gas(&route),
    })
}
```

### E.3 Recovery Procedures

**Scenario: Mass Pool Failures**

```bash
# 1. Identify healthy pools
curl http://localhost:9933/rpc/axial_router/healthy_pools

# 2. Emergency pause if needed
polkadot-js-api tx.axialRouter.emergencyPause() --sudo

# 3. Resume specific pools
polkadot-js-api tx.axialRouter.emergencyResume([
    [ASSET_A, NATIVE],
    [ASSET_B, NATIVE],
]) --sudo

# 4. Force EMA updates
polkadot-js-api tx.axialRouter.forceEmaUpdate([ASSET_A, ASSET_B]) --sudo
```

**Scenario: EMA Divergence**

```bash
# 1. Check current state
curl http://localhost:9933/rpc/axial_router/token_price/ASSET_A

# 2. Calculate fair price from pools
python scripts/calculate_fair_price.py ASSET_A

# 3. Reset if justified
polkadot-js-api tx.axialRouter.resetTokenEma(
    ASSET_A,
    NEW_PRICE
) --sudo

# 4. Monitor convergence
watch 'curl http://localhost:9933/rpc/axial_router/token_price/ASSET_A'
```

## Appendix F: Performance Optimization Tips

### F.1 Storage Optimization

```rust
// Use bounded collections
type MaxPoolsPerToken = ConstU32<20>;
type MaxActiveRoutes = ConstU32<5>;

// Cache frequently accessed data
#[pallet::storage]
pub type RecentRoutes<T> = StorageMap<
    _,
    Blake2_128Concat,
    (AssetId, AssetId),
    BoundedVec<Route, MaxActiveRoutes>,
    ValueQuery,
>;

// Prune stale data in hooks
fn on_finalize(block: BlockNumber) {
    // Remove pools with no activity in 1000 blocks
    Self::prune_inactive_pools(block);
}
```

### F.2 Computation Optimization

```rust
// Batch EMA updates
pub fn batch_update_emas(
    tokens: Vec<AssetId>,
) -> Result<u32, Error> {
    let mut updated = 0;
    for token in tokens.iter().take(10) {  // Limit per call
        if Self::update_token_ema(*token).is_ok() {
            updated += 1;
        }
    }
    Ok(updated)
}

// Lazy evaluation
pub fn get_or_compute_route(
    from: AssetId,
    to: AssetId,
    amount: Balance,
) -> Result<Route, Error> {
    // Check cache first
    if let Some(cached) = RecentRoutes::<T>::get((from, to)).first() {
        if Self::is_route_still_valid(cached) {
            return Ok(cached.clone());
        }
    }

    // Compute and cache
    let route = Self::find_best_route(from, to, amount)?;
    RecentRoutes::<T>::mutate((from, to), |routes| {
        routes.try_push(route.clone()).ok();
    });
    Ok(route)
}
```

### F.3 Gas Reduction Techniques

- **Early returns**: Fail fast on invalid inputs
- **Batch operations**: Group related state changes
- **Lazy loading**: Don't fetch unnecessary data
- **Efficient math**: Use integer operations where possible
- **Storage reads**: Minimize duplicate reads via caching

---

**Version**: 1.0.0
**Date**: October 2025
**License**: MIT
