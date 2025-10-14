# Simple Axial Router Specification

## Abstract

Simple Axial Router is a streamlined multi-token routing system optimized for UTBC+POL ecosystems operating exclusively within the parachain's internal liquidity pools. It provides multi-hop routing through anchor tokens, enabling access to liquidity from pools not directly paired with Native token. The router features POL-aware path selection, two-hop routing for enhanced liquidity discovery, and optional VRF-based transaction ordering for MEV resistance. While most pools are built in pairs with Native token, the multi-hop capability ensures efficient routing across the entire internal liquidity network.

---

## 1. Design Principles

### 1.1 Core Philosophy

1. **Simplicity First** - Single route per swap, no splitting
2. **Internal Pool Focus** - Operates exclusively within parachain's internal liquidity network
3. **POL Awareness** - Subtle preference for liquidity-building paths
4. **Anchor-Based Routing** - Native token as primary hub, with multi-hop for non-Native pairs
5. **Liquidity Accessibility** - Two-hop routing unlocks liquidity from all internal pools
6. **Progressive Enhancement** - Optional features activate when available
7. **Atomic Execution** - All operations complete in single transaction

### 1.2 System Architecture

```
┌──────────────────────────────────────┐
│         Simple Axial Router          │
├──────────────────────────────────────┤
│  ┌────────────────────────────────┐  │
│  │     Route Discovery Engine     │  │
│  ├────────────────────────────────┤  │
│  │     POL Scoring System         │  │
│  ├────────────────────────────────┤  │
│  │     Simple EMA Oracle          │  │
│  ├────────────────────────────────┤  │
│  │     Optional: VRF Ordering     │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼                       ▼
  [UTBC Curves]           [XYK Pools]
```

---

## 2. Data Structures

### 2.1 Core Configuration

```rust
pub struct RouterConfig {
    /// Native token serves as primary routing anchor
    pub native_asset: AssetId,

    /// Secondary anchor tokens (e.g., USDC, USDT)
    pub secondary_anchors: BoundedVec<AssetId, ConstU32<5>>,

    /// Bonus for POL-building routes (in basis points)
    pub pol_preference_bps: u16,  // Default: 10 (0.1%)

    /// Bonus for Native-routed paths (in basis points)
    pub native_preference_bps: u16,  // Default: 5 (0.05%)

    /// Maximum number of hops allowed
    pub max_hops: u8,  // Default: 2

    /// Minimum liquidity for viable pool
    pub min_liquidity: Balance,

    /// VRF transaction ordering enabled
    pub vrf_enabled: bool,  // Default: false

    /// Emergency pause flag
    pub is_paused: bool,
}
```

### 2.2 Routing Types

```rust
pub struct RouteCandidate {
    /// The route path
    pub route: Route,

    /// Expected output amount
    pub expected_output: Balance,

    /// Whether this route builds POL
    pub builds_pol: bool,

    /// Whether this route uses Native
    pub uses_native: bool,

    /// Final score after preferences
    pub score: Balance,
}

pub enum Route {
    /// Direct swap through single pool
    Direct {
        pool_id: PoolId,
        pool_type: PoolType,
    },

    /// Two-hop route through intermediate token
    TwoHop {
        first_pool: PoolId,
        intermediate: AssetId,
        second_pool: PoolId,
        builds_pol: bool,
    },

    /// Special: Double UTBC route
    /// from → UTBC_from → Native → UTBC_to → to
    DoubleUTBC {
        from_curve: CurveId,
        to_curve: CurveId,
    },
}

pub enum PoolType {
    /// Constant product AMM
    XYK,
    /// Unidirectional token bonding curve
    UTBC,
}
```

### 2.3 Price Oracle

```rust
pub struct SimpleEMA {
    /// Exponentially weighted average price
    pub price: Balance,

    /// Block number of last update
    pub last_update: BlockNumber,

    /// Maximum age before considered stale
    pub max_age: BlockNumber,  // Default: 100 blocks
}
```

### 2.4 Optional: VRF Types

```rust
/// When VRF is enabled, swaps can be batched for randomized ordering
pub struct VRFBatch {
    /// Collection block number
    pub block: BlockNumber,

    /// Swaps pending execution
    pub pending_swaps: BoundedVec<PendingSwap, ConstU32<100>>,

    /// VRF seed from randomness source
    pub seed: Option<[u8; 32]>,
}

pub struct PendingSwap {
    /// Unique swap identifier
    pub id: H256,

    /// Swap parameters
    pub user: AccountId,
    pub from: AssetId,
    pub to: AssetId,
    pub amount: Balance,
    pub min_output: Balance,
}
```

---

## 3. Route Discovery

### 3.1 Algorithm

The router discovers optimal paths by evaluating multiple route candidates:

```rust
impl<T: Config> Pallet<T> {
    pub fn find_best_route(
        from: AssetId,
        to: AssetId,
        amount: Balance,
    ) -> Result<Route, Error> {
        let mut candidates = Vec::new();

        // Phase 1: Discover all possible routes within internal pools

        // Check direct pool if exists
        if let Some(pool) = Self::get_direct_pool(from, to) {
            if Self::is_pool_viable(pool) {
                let output = Self::quote_pool(pool, amount)?;
                candidates.push(RouteCandidate {
                    route: Route::Direct {
                        pool_id: pool,
                        pool_type: Self::get_pool_type(pool),
                    },
                    expected_output: output,
                    builds_pol: Self::pool_builds_pol(pool),
                    uses_native: from == T::NativeAsset::get() || to == T::NativeAsset::get(),
                    score: 0,
                });
            }
        }

        // Check double UTBC route if both tokens have curves
        if Self::has_utbc_curve(from) && Self::has_utbc_curve(to) {
            let output = Self::quote_double_utbc(from, to, amount)?;
            candidates.push(RouteCandidate {
                route: Route::DoubleUTBC {
                    from_curve: Self::get_curve_id(from)?,
                    to_curve: Self::get_curve_id(to)?,
                },
                expected_output: output,
                builds_pol: true,  // Always builds POL
                uses_native: true,  // Always goes through Native
                score: 0,
            });
        }

        // Check two-hop routes through Native anchor
        if from != T::NativeAsset::get() && to != T::NativeAsset::get() {
            if let Ok(output) = Self::quote_via_anchor(from, to, T::NativeAsset::get(), amount) {
                candidates.push(Self::create_twohop_candidate(
                    from,
                    T::NativeAsset::get(),
                    to,
                    output
                )?);
            }
        }

        // Check two-hop routes through secondary anchors
        for anchor in T::SecondaryAnchors::get().iter() {
            if from != *anchor && to != *anchor {
                if let Ok(output) = Self::quote_via_anchor(from, to, *anchor, amount) {
                    candidates.push(Self::create_twohop_candidate(from, *anchor, to, output)?);
                }
            }
        }

        // Phase 2: Score all candidates
        for candidate in candidates.iter_mut() {
            candidate.score = Self::calculate_route_score(candidate);
        }

        // Phase 3: Select best route
        candidates.into_iter()
            .max_by_key(|c| c.score)
            .map(|c| c.route)
            .ok_or(Error::<T>::NoRouteFound)
    }
}
```

### 3.2 Route Scoring

Routes are scored based on expected output with configurable preferences:

```rust
impl<T: Config> Pallet<T> {
    fn calculate_route_score(candidate: &RouteCandidate) -> Balance {
        let mut score = candidate.expected_output;

        // Apply POL building preference
        if candidate.builds_pol {
            let bonus = score
                .saturating_mul(T::POLPreferenceBps::get() as u128)
                .saturating_div(10_000);
            score = score.saturating_add(bonus);
        }

        // Apply Native routing preference
        if candidate.uses_native {
            let bonus = score
                .saturating_mul(T::NativePreferenceBps::get() as u128)
                .saturating_div(10_000);
            score = score.saturating_add(bonus);
        }

        score
    }
}
```

---

## 4. Price Oracle

### 4.1 Simple EMA Implementation

The router maintains exponentially weighted moving average prices for manipulation resistance:

```rust
impl<T: Config> Pallet<T> {
    /// Update EMA price for a token pair
    pub fn update_price_ema(
        base: AssetId,
        quote: AssetId,
        spot_price: Balance,
    ) -> DispatchResult {
        let pair_id = Self::get_pair_id(base, quote);

        PriceEMAs::<T>::mutate(pair_id, |maybe_ema| {
            match maybe_ema {
                Some(ema) => {
                    // EMA formula: new = α × spot + (1-α) × old
                    // Using α = 0.1 (1000/10000)
                    let alpha = 1000u128;
                    let one_minus_alpha = 9000u128;

                    ema.price = spot_price
                        .saturating_mul(alpha)
                        .saturating_add(ema.price.saturating_mul(one_minus_alpha))
                        .saturating_div(10000);

                    ema.last_update = frame_system::Pallet::<T>::block_number();
                },
                None => {
                    *maybe_ema = Some(SimpleEMA {
                        price: spot_price,
                        last_update: frame_system::Pallet::<T>::block_number(),
                        max_age: T::EMAMaxAge::get(),
                    });
                }
            }
        });

        Ok(())
    }

    /// Validate that spot price is within acceptable deviation
    pub fn validate_price_deviation(
        base: AssetId,
        quote: AssetId,
        spot_price: Balance,
    ) -> bool {
        let pair_id = Self::get_pair_id(base, quote);

        if let Some(ema) = PriceEMAs::<T>::get(pair_id) {
            let current_block = frame_system::Pallet::<T>::block_number();

            // Check staleness
            if current_block.saturating_sub(ema.last_update) > ema.max_age {
                return true;  // Stale EMA, allow trade
            }

            // Allow 10% deviation
            let lower_bound = ema.price.saturating_mul(90).saturating_div(100);
            let upper_bound = ema.price.saturating_mul(110).saturating_div(100);

            spot_price >= lower_bound && spot_price <= upper_bound
        } else {
            true  // No EMA data, allow trade
        }
    }
}
```

---

## 5. Swap Execution

### 5.1 Standard Swap

```rust
impl<T: Config> Pallet<T> {
    #[pallet::call_index(0)]
    #[pallet::weight(T::WeightInfo::swap())]
    pub fn swap(
        origin: OriginFor<T>,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        min_amount_out: Balance,
        deadline: T::BlockNumber,
    ) -> DispatchResult {
        let who = ensure_signed(origin)?;

        // Validations
        ensure!(!Self::is_paused(), Error::<T>::RouterPaused);
        ensure!(from != to, Error::<T>::IdenticalAssets);
        ensure!(amount_in > 0, Error::<T>::ZeroAmount);
        ensure!(
            frame_system::Pallet::<T>::block_number() <= deadline,
            Error::<T>::DeadlinePassed
        );

        // Find best route
        let route = Self::find_best_route(from, to, amount_in)?;

        // Execute route atomically
        let amount_out = Self::execute_route(&who, &route, amount_in)?;

        // Validate slippage
        ensure!(amount_out >= min_amount_out, Error::<T>::SlippageExceeded);

        // Update price EMAs
        let spot_price = Self::calculate_spot_price(amount_in, amount_out);
        Self::update_price_ema(from, to, spot_price)?;

        // Emit event
        Self::deposit_event(Event::SwapExecuted {
            who,
            from,
            to,
            amount_in,
            amount_out,
            route,
        });

        Ok(())
    }
}
```

### 5.2 Route Execution

```rust
impl<T: Config> Pallet<T> {
    fn execute_route(
        who: &T::AccountId,
        route: &Route,
        amount_in: Balance,
    ) -> Result<Balance, DispatchError> {
        match route {
            Route::Direct { pool_id, pool_type } => {
                Self::execute_single_swap(who, *pool_id, *pool_type, amount_in)
            },

            Route::TwoHop { first_pool, intermediate, second_pool, .. } => {
                // First hop
                let intermediate_amount = Self::execute_single_swap(
                    who,
                    *first_pool,
                    Self::get_pool_type(*first_pool),
                    amount_in,
                )?;

                // Second hop
                Self::execute_single_swap(
                    who,
                    *second_pool,
                    Self::get_pool_type(*second_pool),
                    intermediate_amount,
                )
            },

            Route::DoubleUTBC { from_curve, to_curve } => {
                // Special handling for double UTBC route
                // Step 1: Swap from token to Native via UTBC
                let native_amount = T::UTBCInterface::mint_to_native(
                    *from_curve,
                    who,
                    amount_in,
                )?;

                // Step 2: Swap Native to target token via UTBC
                T::UTBCInterface::mint_from_native(
                    *to_curve,
                    who,
                    native_amount,
                )
            },
        }
    }
}
```

---

## 6. Progressive Enhancement: VRF Ordering

### 6.1 Overview

When a verifiable random function becomes available, the router can enable randomized transaction ordering within blocks for enhanced MEV resistance. This feature is disabled by default and activated through governance.

### 6.2 VRF-Protected Swap

```rust
impl<T: Config> Pallet<T> {
    #[pallet::call_index(1)]
    #[pallet::weight(T::WeightInfo::swap_vrf())]
    pub fn swap_vrf(
        origin: OriginFor<T>,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        min_amount_out: Balance,
    ) -> DispatchResult {
        let who = ensure_signed(origin)?;

        // Check if VRF is enabled
        ensure!(Self::vrf_enabled(), Error::<T>::VRFNotAvailable);

        // Add to pending batch
        let swap_id = Self::generate_swap_id(&who, from, to);

        PendingVRFSwaps::<T>::mutate(|batch| {
            batch.try_push(PendingSwap {
                id: swap_id,
                user: who.clone(),
                from,
                to,
                amount: amount_in,
                min_output: min_amount_out,
            }).map_err(|_| Error::<T>::VRFBatchFull)
        })?;

        Self::deposit_event(Event::SwapQueued { swap_id, who });

        Ok(())
    }
}
```

### 6.3 VRF Batch Processing

```rust
impl<T: Config> Hooks<T::BlockNumber> for Pallet<T> {
    fn on_finalize(block: T::BlockNumber) {
        if !Self::vrf_enabled() {
            return;
        }

        let pending = PendingVRFSwaps::<T>::take();
        if pending.is_empty() {
            return;
        }

        // Get VRF randomness
        if let Some(randomness) = T::RandomnessSource::random_seed() {
            // Shuffle execution order
            let mut indices: Vec<usize> = (0..pending.len()).collect();
            Self::shuffle_indices(&mut indices, &randomness);

            // Execute in randomized order
            for idx in indices {
                if let Some(swap) = pending.get(idx) {
                    let _ = Self::execute_vrf_swap(swap);
                }
            }

            Self::deposit_event(Event::VRFBatchProcessed {
                block,
                count: pending.len() as u32,
            });
        }
    }
}
```

---

## 7. Emergency Controls

```rust
impl<T: Config> Pallet<T> {
    #[pallet::call_index(10)]
    #[pallet::weight(T::WeightInfo::emergency_pause())]
    pub fn emergency_pause(origin: OriginFor<T>) -> DispatchResult {
        T::EmergencyOrigin::ensure_origin(origin)?;

        RouterConfig::<T>::mutate(|config| {
            config.is_paused = true;
        });

        Self::deposit_event(Event::EmergencyPause);
        Ok(())
    }

    #[pallet::call_index(11)]
    #[pallet::weight(T::WeightInfo::emergency_resume())]
    pub fn emergency_resume(origin: OriginFor<T>) -> DispatchResult {
        T::EmergencyOrigin::ensure_origin(origin)?;

        RouterConfig::<T>::mutate(|config| {
            config.is_paused = false;
        });

        Self::deposit_event(Event::EmergencyResume);
        Ok(())
    }
}
```

---

## 8. Events and Errors

### 8.1 Events

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
        route: Route,
    },

    /// Swap queued for VRF processing
    SwapQueued {
        swap_id: H256,
        who: T::AccountId,
    },

    /// VRF batch processed
    VRFBatchProcessed {
        block: T::BlockNumber,
        count: u32,
    },

    /// Price EMA updated
    PriceEMAUpdated {
        base: AssetId,
        quote: AssetId,
        price: Balance,
    },

    /// Emergency pause activated
    EmergencyPause,

    /// Emergency pause lifted
    EmergencyResume,
}
```

### 8.2 Errors

```rust
#[pallet::error]
pub enum Error<T> {
    /// No viable route found between tokens
    NoRouteFound,

    /// Identical source and target assets
    IdenticalAssets,

    /// Amount is zero
    ZeroAmount,

    /// Insufficient liquidity in pools
    InsufficientLiquidity,

    /// Output amount below minimum acceptable
    SlippageExceeded,

    /// Transaction deadline passed
    DeadlinePassed,

    /// Router is currently paused
    RouterPaused,

    /// VRF feature not available
    VRFNotAvailable,

    /// VRF batch is full
    VRFBatchFull,

    /// Price deviates too much from EMA
    ExcessivePriceDeviation,

    /// Arithmetic overflow
    Overflow,
}
```

---

## 9. Configuration

### 9.1 Pallet Configuration

```rust
#[pallet::config]
pub trait Config: frame_system::Config {
    /// The overarching event type
    type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

    /// Asset registry for balance operations
    type Assets: fungibles::Inspect<Self::AccountId>
        + fungibles::Mutate<Self::AccountId>;

    /// Interface to UTBC curves
    type UTBCInterface: UTBCInterface<Self::AccountId, AssetId, Balance>;

    /// Pool registry
    type Pools: PoolRegistry<AssetId, Balance>;

    /// Source of randomness (optional)
    type RandomnessSource: RandomnessSource<[u8; 32]>;

    /// Origin for emergency operations
    type EmergencyOrigin: EnsureOrigin<Self::RuntimeOrigin>;

    /// Native asset ID
    #[pallet::constant]
    type NativeAsset: Get<AssetId>;

    /// Secondary anchor assets
    #[pallet::constant]
    type SecondaryAnchors: Get<Vec<AssetId>>;

    /// POL building preference (basis points)
    #[pallet::constant]
    type POLPreferenceBps: Get<u16>;

    /// Native routing preference (basis points)
    #[pallet::constant]
    type NativePreferenceBps: Get<u16>;

    /// EMA maximum age in blocks
    #[pallet::constant]
    type EMAMaxAge: Get<Self::BlockNumber>;

    /// Weight information
    type WeightInfo: WeightInfo;
}
```

### 9.2 Genesis Configuration

```rust
#[pallet::genesis_config]
pub struct GenesisConfig<T: Config> {
    pub initial_config: RouterConfig,
    pub initial_anchors: Vec<AssetId>,
}

#[pallet::genesis_build]
impl<T: Config> GenesisBuild<T> for GenesisConfig<T> {
    fn build(&self) {
        // Initialize router configuration
        RouterConfig::<T>::put(&self.initial_config);

        // Set up initial anchor tokens
        for anchor in &self.initial_anchors {
            SecondaryAnchors::<T>::mutate(|anchors| {
                let _ = anchors.try_push(*anchor);
            });
        }
    }
}
```

---

## 10. Security Considerations

### 10.1 Price Manipulation

- EMA oracle provides resistance against flash loan attacks
- 10% deviation limit prevents extreme price manipulation
- Multi-hop routes reduce single-pool manipulation impact

### 10.2 MEV Protection

- Optional VRF ordering eliminates predictable transaction ordering
- POL preference creates long-term value alignment
- Atomic execution prevents partial fills

### 10.3 Liquidity Risks

- Minimum liquidity requirements filter out thin pools
- Multi-path discovery provides fallback routes
- Emergency pause allows rapid response to issues

---

## 11. Testing Requirements

### 11.1 Core Functionality

- Route discovery correctness across various topologies
- Price calculation accuracy
- Atomic execution guarantees
- Slippage protection enforcement
- EMA convergence and staleness handling

### 11.2 Edge Cases

- Circular routing prevention
- Zero liquidity handling
- Maximum hop enforcement
- Overflow protection in calculations

### 11.3 Optional Features

- VRF randomization fairness
- VRF batch processing correctness
- Emergency pause/resume functionality

---

## Conclusion

Simple Axial Router provides essential multi-token routing functionality for UTBC+POL ecosystems while maintaining implementation simplicity. The design prioritizes atomic execution, POL growth, and progressive enhancement through optional features like VRF ordering. By focusing on single-route execution and avoiding complex splitting mechanisms, the router remains auditable and maintainable while serving the needs of sophisticated token economies.

---

**Version**: 1.0.0
**Date**: October 2025
