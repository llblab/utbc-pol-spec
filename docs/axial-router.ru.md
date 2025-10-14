# Спецификация Axial Router

_Детерминированный маршрутизатор ликвидности с опорными активами для паллетов Substrate Frame_

## 1. Исполнительное резюме

Axial Router — паллет Substrate Frame, реализующий детерминированную маршрутизацию ликвидности через назначенные опорные активы. Система поддерживает согласованность цен за счёт экспоненциальных скользящих средних (EMA) по токенам, взвешенных по TVL, одновременно ограничивая сложность маршрутизации до O(#anchors), что обеспечивает предсказуемые затраты газа и надёжное ценовое обнаружение.

### Ключевые архитектурные принципы

- **Токенные оракулы** — единая EMA на токен, агрегирующая данные по всем пулам
- **TVL-взвешенная агрегация** — актуальный TVL пулов определяет решения по маршрутизации и справедливую цену
- **Фиксированное сглаживание** — единый коэффициент α для всех обновлений EMA
- **Детерминированное исполнение** — ограниченная сложность с предсказуемой производительностью
- **Маршрутизация с учётом здоровья** — исключение пулов, нарушающих пороги успеха и проскальзывания
- **Совместимость с POL** — ликвидность, принадлежащая протоколу, участвует на равных правах с LP-позициями

### Целевые показатели производительности

| Свойство                | Целевое значение | Обоснование                             |
| ----------------------- | ---------------- | --------------------------------------- |
| Сложность маршрутизации | O(#anchors)      | Предсказуемая производительность        |
| Максимум переходов      | 2                | Баланс между эффективностью и простотой |
| Целевой масштаб         | 50-500 токенов   | Требования ликвидности парачейна        |
| Газ на свап             | <200k weight     | Экономическая целесообразность          |
| Частота обновления цен  | Каждый блок      | Обновления только при активности        |
| Лимит устаревания EMA   | 30 блоков        | Баланс свежести и стоимости обновления  |

## 2. Архитектура системы

### 2.1 Обзор компонентов

```
┌───────────────────────────────────────────────────────┐
│ Extrinsics (FRAME)                                    │
│ swap() · add_anchor() · pause_pool() · reset_ema()    │
└───────────────────────┬───────────────────────────────┘
                        ▼
┌───────────────────────────────────────────────────────┐
│ Паллета AxialRouter (ядро)                            │
│ • Планирование маршрутов и исполнение                 │
│ • Мониторинг здоровья                                 │
│ • Распределение по маршрутам (опционально)            │
└──────────┬────────────────────────────┬───────────────┘
           ▼                            ▼
┌─────────────────────┐  ┌──────────────────────────────┐
│ Адаптеры пулов      │  │ Подсистема токенных оракулов │
│ • XYK (константный) │  │ • Расчёт EMA                 │
│ • UTBC (опция)      │  │ • Фиксированные α-обновления │
│ • Внешние мосты     │  │ • Контроль TTL               │
└─────────────────────┘  └──────────────────────────────┘
```

### 2.2 Структура паллеты

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

### 2.3 Базовые типы данных

```rust
/// Токенная экспоненциальная скользящая средняя с метаданными здоровья
pub struct TokenEMA<BlockNumber> {
    /// Текущая EMA-цена в базовой единице (18 знаков)
    pub ema_price: FixedU128,
    /// Последняя агрегированная спот-цена
    pub last_price: FixedU128,
    /// Номер блока последнего обновления
    pub last_updated: BlockNumber,
    /// Совокупная ликвидность по всем пулам
    pub total_liquidity: Balance,
    /// Время жизни данных в блоках
    pub ttl: BlockNumber,
}

/// Информация о пуле с резервами и метриками здоровья
pub struct PoolInfo<T: Config> {
    /// Идентификатор адаптера пула
    pub pool_id: PoolId,
    /// Текущие резервы
    pub reserve_base: Balance,
    pub reserve_quote: Balance,
    /// Общая стоимость ликвидности (включая долю POL)
    pub tvl: Balance,
    /// Время последней активности
    pub last_activity: BlockNumberFor<T>,
    /// Метрики здоровья и производительности
    pub health: PoolHealth<BlockNumberFor<T>>,
}

/// Комплексное отслеживание здоровья пула
pub struct PoolHealth<BlockNumber> {
    /// Экспоненциально взвешенная доля успешных операций
    pub success_rate: Permill,
    /// Среднее проскальзывание (факт против ожидания)
    pub avg_slippage: FixedU128,
    /// Опциональный горизонт паузы (governance)
    pub paused_until: Option<BlockNumber>,
}

/// Стратегия распределения по маршрутам
pub enum RouteMode {
    /// Один лучший маршрут (по умолчанию)
    Single,
    /// Распределение по нескольким маршрутам
    Split { max_routes: u8 },
}

/// Глобальная конфигурация системы
pub struct SystemConfig<T: Config> {
    /// Список опорных активов
    pub anchors: BoundedVec<AssetId, T::MaxAnchors>,
    /// Фиксированный коэффициент сглаживания EMA
    pub ema_alpha: FixedU128,
    /// Минимальная ликвидность для учёта пула
    pub min_liquidity: Balance,
    /// Порог устаревания EMA
    pub ema_ttl: BlockNumberFor<T>,
    /// Режим распределения маршрутов
    pub route_mode: RouteMode,
    /// Ограничение только внутренними пулами
    pub internal_only: bool,
    /// Минимально допустимая доля успешных операций
    pub success_threshold: Permill,
    /// Максимально допустимое среднее проскальзывание
    pub slippage_cap: Permill,
}

/// План выполнения маршрута
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

## 3. Токенный оркул

### 3.1 TVL-взвешенная агрегация цены

Для токена T в момент времени t агрегированная цена по всем здоровым пулам считается как

$$P_{agg}^T(t) = \frac{\sum_{i \in \mathcal{P}_T} TVL_i(t) \cdot P_i^T(t)}{\sum_{i \in \mathcal{P}_T} TVL_i(t)}$$

где:

- $\mathcal{P}_T$ — множество пулов с токеном T, у которых $TVL_i \geq L_{min}$
- $P_i^T$ — маржинальная цена токена T в пуле i (quote/base или base/quote)
- Пул i учитывается, если: `health.paused_until` отсутствует или истёк, и `last_activity + ema_ttl ≥ now`

### 3.2 Фиксированный коэффициент сглаживания

Для всех токенов используется единый коэффициент сглаживания `ema_alpha`, настраиваемый через управление. Рекомендуемые значения лежат в диапазоне 0.02–0.05 и обеспечивают компромисс между отзывчивостью и подавлением шумов без зависимостей от текущей волатильности или ликвидности.

### 3.3 Формула обновления EMA

Стандартная EMA первого порядка:

$$EMA_T(t) = (1 - \alpha) \cdot EMA_T(t-1) + \alpha \cdot P_{agg}^T(t)$$

### 3.4 Реализация

```rust
impl<T: Config> Pallet<T> {
    /// Обновить EMA токена на основе текущего состояния пулов
    pub fn update_token_ema(
        token: AssetId
    ) -> Result<(), Error<T>> {
        let current_block = frame_system::Pallet::<T>::block_number();
        let pools = Self::get_active_pools_for_token(token)?;

        ensure!(!pools.is_empty(), Error::<T>::NoActivePools);

        // Посчитать TVL-взвешенную цену
        let mut weighted_sum = FixedU128::zero();
        let mut total_tvl = Balance::zero();

        for (pool_key, pool) in pools.iter() {
            // Пропустить нездоровые пулы
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

        // Обновить или инициализировать EMA
        let config = RouterConfig::<T>::get();
        let alpha = config.ema_alpha;

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

    /// Проверить здоровье пула для маршрутизации
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

## 4. Алгоритм маршрутизации

### 4.1 Поиск маршрута с учётом здоровья

```rust
impl<T: Config> Pallet<T> {
    /// Найти оптимальный маршрут(ы) исходя из конфигурации
    pub fn find_best_route(
        from: AssetId,
        to: AssetId,
        amount: Balance,
    ) -> Result<Route, Error<T>> {
        let config = RouterConfig::<T>::get();
        let current_block = frame_system::Pallet::<T>::block_number();

        // Случай 1: прямой свап, если один из активов — опорный
        if Self::is_anchor(&from) || Self::is_anchor(&to) {
            if let Some(pool) = Pools::<T>::get(&from, &to) {
                if Self::is_pool_healthy(&pool, current_block) {
                    return Ok(Route::Direct { from, to });
                }
            }
        }

        // Случай 2: двухходовая маршрутизация через опоры
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

    /// Найти лучший одиночный маршрут через опоры
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
            // Пропустить совпадения с from/to
            if anchor == &from || anchor == &to {
                continue;
            }

            // Получить оба пула
            let pool1 = Pools::<T>::get(&from, anchor);
            let pool2 = Pools::<T>::get(anchor, &to);

            if let (Some(p1), Some(p2)) = (pool1, pool2) {
                // Проверка здоровья
                if !Self::is_pool_healthy(&p1, current_block)
                    || !Self::is_pool_healthy(&p2, current_block) {
                    continue;
                }

                // Посчитать оценку маршрута
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

    /// Найти и распределить маршруты в режиме Split (расширенный функционал)
    fn find_split_routes(
        from: AssetId,
        to: AssetId,
        amount: Balance,
        anchors: &BoundedVec<AssetId, T::MaxAnchors>,
        max_routes: u8,
    ) -> Result<Route, Error<T>> {
        let current_block = frame_system::Pallet::<T>::block_number();
        let mut scored_routes = Vec::new();

        // Собрать все подходящие маршруты с оценками
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

        // Отсортировать по убыванию
        scored_routes.sort_by(|a, b| b.1.cmp(&a.1));

        // Выбрать топ N маршрутов
        let selected = scored_routes
            .into_iter()
            .take(max_routes as usize)
            .collect::<Vec<_>>();

        // Распределить пропорционально оценке ликвидности
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

### 4.2 Комплексная оценка маршрутов

```rust
impl<T: Config> Pallet<T> {
    /// Оценить маршрут по ожидаемому выходу, ликвидности и здоровью
    fn score_route(
        from: &AssetId,
        via: &AssetId,
        to: &AssetId,
        amount: Balance,
        pool1: &PoolInfo<T>,
        pool2: &PoolInfo<T>,
    ) -> Result<FixedU128, Error<T>> {
        // Смоделировать выходы свапов
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

        // Получить справедливую стоимость из EMA
        let from_ema = TokenOracles::<T>::get(from)
            .ok_or(Error::<T>::OracleNotFound)?;
        let to_ema = TokenOracles::<T>::get(to)
            .ok_or(Error::<T>::OracleNotFound)?;

        let expected_fair_output = FixedU128::from_inner(amount)
            .saturating_mul(from_ema.ema_price)
            .checked_div(&to_ema.ema_price)
            .ok_or(Error::<T>::MathOverflow)?;

        // Коэффициент ценовой эффективности
        let price_efficiency = FixedU128::from_inner(final_output)
            .checked_div(&expected_fair_output)
            .unwrap_or_else(FixedU128::zero);

        // Оценка ликвидности (геометрическое среднее TVL)
        let liquidity_score = {
            let product = (pool1.tvl as u128)
                .saturating_mul(pool2.tvl as u128);
            let sqrt = Self::integer_sqrt(product);
            FixedU128::from_inner(sqrt)
        };

        // Штраф за здоровье
        let health_penalty = Self::calculate_health_penalty(pool1, pool2)?;

        // Композитная оценка
        let base_score = price_efficiency
            .saturating_mul(liquidity_score)
            .saturating_div(FixedU128::from_inner(1_000_000_000_000_000_000)); // Нормализация

        Ok(base_score.saturating_sub(health_penalty))
    }

    /// Посчитать штраф за здоровье на основе метрик пулов
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

    /// Целочисленный корень (для оценки ликвидности)
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

## 5. Исполнение свапов

### 5.1 Основная точка входа

```rust
#[pallet::call]
impl<T: Config> Pallet<T> {
    /// Выполнить свап с автоматической маршрутизацией
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

        // Проверка входных данных
        ensure!(from != to, Error::<T>::IdenticalAssets);
        ensure!(amount_in > Balance::zero(), Error::<T>::ZeroAmount);

        // Найти оптимальный маршрут
        let route = Self::find_best_route(from, to, amount_in)?;

        // Проверка количества переходов
        if let Some(max) = max_hops {
            let hops = Self::count_hops(&route);
            ensure!(hops <= max, Error::<T>::TooManyHops);
        }

        // Исполнить маршрут(ы)
        let amount_out = Self::execute_route(&who, &route, amount_in)?;

        // Защита от проскальзывания
        ensure!(
            amount_out >= min_amount_out,
            Error::<T>::SlippageExceeded
        );

        // Обновить EMA для токенов
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

    /// Аварийная пауза пула
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

    /// Сбросить EMA токена (только управление)
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

### 5.2 Исполнение маршрута с атомарностью

```rust
impl<T: Config> Pallet<T> {
    /// Исполнить маршрут атомарно
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

    /// Выполнить одиночный свап через пул с учётом здоровья
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

            // Рассчитать ожидаемый выход
            let expected_out = Self::calculate_swap_output(
                pool,
                amount_in,
                &from,
                &to
            )?;

            // Исполнить через адаптер
            let actual_out = Self::adapter_swap(
                pool,
                who,
                from,
                to,
                amount_in
            )?;

            // Посчитать проскальзывание
            let slippage = if expected_out > Balance::zero() {
                let diff = expected_out.saturating_sub(actual_out);
                FixedU128::from_rational(diff, expected_out)
            } else {
                FixedU128::zero()
            };

            // Обновить здоровье пула
            let success = actual_out > Balance::zero();
            Self::update_pool_health(pool, success, slippage, current_block)?;

            // Обновить состояние пула
            pool.last_activity = current_block;
            Self::recalculate_pool_tvl(pool, from, to)?;

            Ok(actual_out)
        })
    }

    /// Обновить резервы и TVL пула после свапа
    fn recalculate_pool_tvl(
        pool: &mut PoolInfo<T>,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(), Error<T>> {
        // Получить актуальные резервы из адаптера
        let (reserve_base, reserve_quote) = Self::adapter_get_reserves(
            &pool.pool_id,
            base,
            quote
        )?;

        pool.reserve_base = reserve_base;
        pool.reserve_quote = reserve_quote;

        // Посчитать TVL через EMA токенов
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

## 5.3 Управление здоровьем пулов

```rust
impl<T: Config> Pallet<T> {
    /// Обновить метрики здоровья пула после попытки свапа
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


```

## 6. Гарантии безопасности

### 6.1 Инварианты системы

| Инвариант                 | Описание                                  | Обеспечение                             |
| ------------------------- | ----------------------------------------- | --------------------------------------- |
| **Детерминизм маршрутов** | Идентичное состояние → одинаковый маршрут | Чистые функции, отсутствие случайностей |
| **Ценовая когерентность** | `EMA - Spot < 50%` за окно                | Фиксированная α + TVL-взвешивание       |
| **Ограничение сложности** | Макс. 2 перехода на свап                  | Жёсткое условие в алгоритме             |
| **Минимум ликвидности**   | `TVL ≥ MinLiquidity` для участия          | Предфильтрация при агрегации            |
| **Атомарность**           | Всё или ничего                            | Откат транзакций при ошибке             |
| **Пороги здоровья**       | Пулы ниже порогов исключаются             | Проверки успешности и проскальзывания   |

### 6.2 Механизмы устойчивости к MEV

- **Ценообразование на EMA**: одномоментное манипулирование ценой не сдвигает EMA существенно
- **TVL-взвешивание**: требует контроля глубоких резервов сразу в нескольких пулах
- **Пороги здоровья**: пулы с низким успехом или высоким проскальзыванием исключаются
- **Защита от проскальзывания**: пользователь задаёт `min_amount_out`
- **Детерминированная маршрутизация**: отсутствие преимуществ от порядка транзакций
- **Фиксированное сглаживание**: стабильная α не даёт одиночному блоку доминировать

**Опциональное улучшение**: перестановка транзакций на уровне консенсуса через VRF для дополнительной защиты.

### 6.3 Анализ поверхности атаки

| Вектор атаки          | Митигация                        | Остаточный риск                        |
| --------------------- | -------------------------------- | -------------------------------------- |
| Манипуляции оракулом  | TVL-взвешенная агрегация         | Требует >50% контроля ликвидности      |
| Фронтраннинг          | EMA-цены + лимит проскальзывания | Ограничено допуском по проскальзыванию |
| Дренаж пула           | Проверка минимальной ликвидности | Отсутствует при соблюдении правил      |
| Спам-свапы            | Лимиты веса + комиссии           | Экономический сдерживающий фактор      |
| Манипуляция здоровьем | Исключение по порогам            | Низкий, требует длительных сбоев       |
| Устаревшие данные     | TTL + оффчейн-воркеры            | Незначительный при сбое воркеров       |

### 6.4 Аварийные механизмы

```rust
#[pallet::call]
impl<T: Config> Pallet<T> {
    /// Глобальный рубильник
    #[pallet::weight(T::WeightInfo::emergency_pause())]
    #[pallet::call_index(10)]
    pub fn emergency_pause(
        origin: OriginFor<T>,
    ) -> DispatchResult {
        T::EmergencyOrigin::ensure_origin(origin)?;

        RouterConfig::<T>::mutate(|config| {
            // Временно отключить маршрутизацию
            config.route_mode = RouteMode::Single;

            // Поставить все пулы на паузу
            for ((base, quote), mut pool) in Pools::<T>::iter() {
                pool.health.paused_until = Some(BlockNumberFor::<T>::max_value());
                Pools::<T>::insert(base, quote, pool);
            }
        });

        Self::deposit_event(Event::EmergencyPause);
        Ok(())
    }

    /// Возобновить работу после аварии
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

    /// Форсировать пересчёт EMA
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

## 7. Конфигурация и настройка

### 7.1 Справочник параметров

| Параметр            | Значение по умолчанию | Диапазон  | Влияние                            | Рекомендации                              |
| ------------------- | --------------------- | --------- | ---------------------------------- | ----------------------------------------- |
| `MaxAnchors`        | 6                     | 3-12      | Выбор маршрутов vs сложность       | Начните консервативно (3-5)               |
| `ema_alpha`         | 0.03                  | 0.01-0.05 | Отзывчивость EMA                   | Ниже = больше сглаживание                 |
| `min_liquidity`     | 10 000 единиц         | >0        | Порог включения пула               | Настраивайте по стоимости токена          |
| `ema_ttl`           | 30 блоков             | 10-120    | Лимит устаревания данных           | Рекомендуется ~2-3 минуты                 |
| `success_threshold` | 70%                   | 50-90%    | Минимальное требование к здоровью  | Повышайте для более строгой маршрутизации |
| `slippage_cap`      | 5%                    | 1-20%     | Допустимое среднее проскальзывание | Выше для волатильных рынков               |
| `route_mode`        | `Single`              | -         | Производительность vs оптимизация  | Сначала используйте `Single`              |
| `internal_only`     | `true`                | bool      | Доступ к внешним пулам             | Отключите до аудита                       |

### 7.2 Переопределения на уровне токенов

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

### 7.3 Пример конфигурации рантайма

```rust
impl pallet_axial_router::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type Assets = Assets;
    type MaxAnchors = ConstU32<6>;
    type MinLiquidity = ConstU128<10_000_000_000_000>; // 10k единиц
    type EmaMaxAge = ConstU32<30>; // 30 блоков
    type EmergencyOrigin = EnsureRootOrHalfCouncil;
    type WeightInfo = weights::SubstrateWeight<Runtime>;
}

// Инициализация через управление
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

## 8. Интеграция POL (Protocol-Owned Liquidity)

### 8.1 Подход к дизайну

POL участвует как **обычный поставщик ликвидности** без исключений:

- POL-токены заблокированы в резервах, как и у LP
- Расчёты TVL естественно учитывают долю POL
- Отдельная логика маршрутизации или приоритеты отсутствуют
- Награды POL распределяются по стандартным правилам LP
- Метрики здоровья одинаковы для POL и ликвидности пользователей

### 8.2 Реализация

```rust
/// POL отслеживается на уровне адаптеров, а не маршрутизатора
pub trait PoolAdapter<AccountId, AssetId, Balance> {
    /// Получить общие резервы (POL + LP)
    fn get_reserves(
        pool_id: PoolId,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(Balance, Balance), Error>;

    /// Выполнить свап (POL прозрачен)
    fn swap(
        pool_id: PoolId,
        who: &AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
    ) -> Result<Balance, Error>;

    /// Запросить долю POL (для телеметрии)
    fn pol_share(
        pool_id: PoolId,
    ) -> Option<Permill>;
}
```

### 8.3 Особенности POL

- **Глубина ликвидности**: POL увеличивает эффективный TVL для маршрутизации
- **Стабильность цен**: протокол может обеспечивать контрциклическую ликвидность
- **Управление рисками**: POL подвержён impermanent loss, как и LP
- **Говернанс**: решения по распределению POL находятся вне рамок маршрутизатора

## 9. Требования к тестированию

### 9.1 Покрытие модульными тестами

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ema_calculation_accuracy() {
        // Проверить TVL-взвешенную агрегацию
        // Протестировать границы адаптивной alpha
        // Убедиться в корректности EWMA волатильности
    }

    #[test]
    fn route_scoring_determinism() {
        // Одинаковые входы → одинаковые выходы
        // Проверить порядок оценок
        // Тест краевых случаев (ноль ликвидности, высокая волатильность)
    }

    #[test]
    fn health_state_transitions() {
        // Успех → улучшение показателей
        // Сбой → ухудшение и отступление
        // Восстановление после истечения отступления
    }

    #[test]
    fn slippage_protection() {
        // Отклонять свапы ниже min_amount_out
        // Триггер отступления при высоком проскальзывании
        // Проверить точность расчёта
    }

    #[test]
    fn liquidity_filtering() {
        // Исключить пулы ниже MinLiquidity
        // Корректно обработать нулевой TVL
        // Протестировать переопределения на токенах
    }

    #[test]
    fn ttl_enforcement() {
        // Устаревшая EMA увеличивает штраф
        // Триггеры оффчейн-воркеров
        // Ручное принудительное обновление
    }
}
```

### 9.2 Интеграционные тесты

```rust
#[cfg(test)]
mod integration {
    #[test]
    fn multi_hop_optimality() {
        // Сравнить прямые и двухходовые маршруты
        // Проверить выбор лучшего маршрута
        // Тест режима Split
    }

    #[test]
    fn atomic_execution() {
        // Сбой в середине маршрута → полный откат
        // Отсутствие частичных изменений состояния
        // Последовательность событий
    }

    #[test]
    fn pool_lifecycle() {
        // Нормальная работа
        // Сбой → отступление
        // Восстановление → возобновление
        // Аварийная пауза/возврат
    }

    #[test]
    fn ema_convergence() {
        // Сценарий ценового шока
        // Проверить скорость схождения
        // Протестировать адаптацию α
    }

    #[test]
    fn pol_participation() {
        // Доля POL учитывается в TVL
        // Нет приоритета маршрутизации
        // Равные правила здоровья
    }
}
```

### 9.3 Стресс- и бенчмарк-тесты

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
            let n in 1 .. 10; // число пулов
        }: update_token_ema(ASSET_A)

        find_route {
            let a in 3 .. 10; // число опор
        }: find_best_route(ASSET_A, ASSET_B, 1_000_000)
    }

    #[test]
    fn test_500_tokens() {
        // Проверить производительность на масштабе
        // Макс. 500 токенов, 10 опор
        // Все операции < 200k weight
    }

    #[test]
    fn price_shock_resilience() {
        // Мгновенное изменение цены ±50%
        // Система остаётся стабильной
        // Отсутствие манипуляции оракулом
    }

    #[test]
    fn mass_pool_failures() {
        // Одновременный сбой 50% пулов
        // Маршрутизация продолжается через здоровые
        // Восстановление после восстановления метрик
    }
}
```

## 10. Мониторинг и эксплуатация

### 10.1 Интеграция телеметрии

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

// Пример использования
Self::emit_telemetry("swap_executed", vec![
    ("from", format!("{:?}", from)),
    ("to", format!("{:?}", to)),
    ("amount", amount.to_string()),
    ("route", route_type),
    ("slippage_bps", (slippage * 10000).to_string()),
]);
```

### 10.2 Метрики Prometheus

```rust
// Экспортируемые метрики
- axial_router_swaps_total{route_type, success}
- axial_router_route_score{from, via, to}
- axial_router_token_ema_price{token}
- axial_router_pool_tvl{base, quote}
- axial_router_pool_success_rate{pool_id}
- axial_router_pool_avg_slippage{pool_id}
- axial_router_ema_staleness_blocks{token}
```

### 10.3 Операционные алерты

| Условие алерта                     | Критичность | Рекомендуемое действие                       |
| ---------------------------------- | ----------- | -------------------------------------------- |
| `total_tvl < MinLiquidity`         | Critical    | Проверить возможный отток ликвидности        |
| `success_rate < success_threshold` | Critical    | Диагностировать адаптер пула                 |
| `avg_slippage > slippage_cap`      | Warning     | Привлечь LP или скорректировать пороги       |
| `staleness > ema_ttl`              | Warning     | Проверить работу оффчейн-воркеров            |
| `emergency_pause`                  | Critical    | Запустить процедуру реагирования на инцидент |

### 10.4 Оффчейн-воркеры

```rust
#[pallet::hooks]
impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
    fn offchain_worker(block_number: BlockNumberFor<T>) {
        // Обновить устаревшие EMA
        let stale_tokens = Self::find_stale_emas(block_number);
        for token in stale_tokens {
            if let Err(e) = Self::update_token_ema(token) {
                log::warn!("Offchain EMA update failed: {:?}", e);
            }
        }

        // Отправить снэпшот метрик здоровья
        Self::emit_health_snapshot(block_number);
    }
}
```

## 11. Миграция и обновления

### 11.1 Переход с существующего DEX

```rust
/// Фаза 1: параллельный деплой (нулевой риск)
#[pallet::genesis_config]
pub struct GenesisConfig {
    pub import_pools: Vec<(AssetId, AssetId, Balance, Balance)>,
    pub initial_anchors: Vec<AssetId>,
    pub config: SystemConfig,
}

#[pallet::genesis_build]
impl<T: Config> GenesisBuild<T> for GenesisConfig {
    fn build(&self) {
        // Импорт существующих пулов
        for (base, quote, reserve_b, reserve_q) in &self.import_pools {
            let pool = PoolInfo {
                pool_id: Self::generate_pool_id(*base, *quote),
                reserve_base: *reserve_b,
                reserve_quote: *reserve_q,
                tvl: Balance::zero(), // Рассчитать после EMA
                last_activity: frame_system::Pallet::<T>::block_number(),
                health: PoolHealth::default(),
            };
            Pools::<T>::insert(base, quote, pool);
        }

        // Инициализировать EMA из спот-цен
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

        // Установить конфигурацию
        RouterConfig::<T>::put(self.config.clone());
        Anchors::<T>::put(self.initial_anchors.clone().try_into().unwrap());
    }
}

/// Фаза 2: параллельная работа (низкий риск)
// Запустить обе системы, сравнивать выходы, мониторить расхождение

/// Фаза 3: постепенная миграция (управляемый риск)
pub fn migrate_routing_percentage(pct: Permill) -> Weight {
    // Маршрутизировать pct% через Axial, остальное через легаси
    // Пошаговое увеличение под контролем управления
}

/// Фаза 4: окончательное переключение (после валидации)
pub fn finalize_migration() -> DispatchResult {
    ensure_root(origin)?;
    // Отключить старый маршрутизатор
    // Направить 100% трафика через Axial
    Ok(())
}
```

### 11.2 Миграции хранилища

```rust
pub mod v2 {
    use super::*;

    pub fn migrate<T: Config>() -> Weight {
        let version = StorageVersion::get::<Pallet<T>>();

        if version < 2 {
            log::info!("Migrating AxialRouter to v2...");

            // Добавить новые поля здоровья
            Pools::<T>::translate(|_base, _quote, old: PoolInfoV1<T>| {
                Some(PoolInfo {
                    pool_id: old.pool_id,
                    reserve_base: old.reserve_base,
                    reserve_quote: old.reserve_quote,
                    tvl: old.tvl,
                    last_activity: old.last_activity,
                    health: PoolHealth {
                        success_rate: old.success_rate,
                        avg_slippage: FixedU128::zero(), // Новое поле
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

## 12. Будущие улучшения

### 12.1 Краткосочные (следующие 6 месяцев)

- [ ] **VRF-упорядочивание транзакций**: интеграция на уровне консенсуса для MEV-защиты
- [ ] **Кроссчейн-опоры**: поддержка внешних пулов через XCM
- [ ] **Продвинутая телеметрия**: дашборды Grafana и алертинг
- [ ] **Стимулы ликвидности**: награды для недозагруженных маршрутов
- [ ] **Оптимизация газа**: дальнейшее снижение веса через батч-операции

### 12.2 Среднесрочные (6-12 месяцев)

- [ ] **Концентрированная ликвидность**: диапазонные ордера в стиле Uniswap V3
- [ ] **Маршрутизация по интентам**: сопоставление пользовательских интентов с оптимальными путями
- [ ] **Машинное обучение**: прогностические оценки здоровья
- [ ] **Мультиактивные свапы**: сложные сделки в одной транзакции
- [ ] **Функции приватности**: zk-доказательства объёмов свапа

### 12.3 Исследовательские направления

- **Гибридные AMM**: комбинация XYK и ордербуков
- **Защита MEV между доменами**: координация на уровне парачейна
- **Адаптивные комиссии**: динамика в зависимости от волатильности
- **Децентрализованные сетевые оракулы**: интеграция внешних цен
- **Игровая теория безопасности**: формальная проверка стимулов

## 13. Соответствие и аудит

### 13.1 Чек-лист аудита

- [ ] Математическая корректность расчётов EMA
- [ ] Защита от переполнений/знаков в арифметике
- [ ] Защита от реэнтранси при внешних вызовах
- [ ] Контроль доступа для привилегированных функций
- [ ] Макет хранения для безопасных обновлений
- [ ] Точность расчёта веса
- [ ] Экономические векторы атаки
- [ ] Обработка краевых случаев (ноль, идентичные активы и т. п.)

### 13.2 Цели формальной верификации

```rust
// Инварианты для доказательства:
// 1. Сохранение стоимости: Σ(inputs) ≥ Σ(outputs) + fees
// 2. Границы цены: EMA в [spot * 0.5, spot * 1.5]
// 3. Ограничение сложности: route_hops(any_swap) ≤ 2
// 4. Монотонность здоровья: последовательный успех → улучшение метрик
```

## Приложение A: математические доказательства

### A.1 Сходимость EMA

**Теорема**: при стабильной агрегированной цене $P_0$ EMA сходится к $P_0$ экспоненциально.

**Доказательство**: полагая $\epsilon_t = |EMA_t - P_0|$, получаем:

$\epsilon_{t+1} = |(1-\alpha)EMA_t + \alpha P_0 - P_0|$

$= |(1-\alpha)(EMA_t - P_0)|$

$= (1-\alpha)\epsilon_t$

Следовательно $\epsilon_t = (1-\alpha)^t \epsilon_0 \to 0$ при $t \to \infty$. $\square$

### A.2 Сложность маршрутизации

**Теорема**: при $A$ опорных активах и $T$ токенах худшая сложность маршрутизации — $O(A)$.

**Доказательство**: поиск маршрута итерируется по опорам (не более $A$), выполняя константное количество обращений к пулам и оценок. Вложенных циклов по токенам нет. Итоговая операция: $O(A \cdot C) = O(A)$, где $C$ — константа. $\square$

## Приложение B: полный API

### B.1 Экстразики

```rust
// Основные торговые операции
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

// Управление опорами (через говернанс)
pub fn add_anchor(
    origin: OriginFor<T>,
    asset: AssetId,
) -> DispatchResult;

pub fn remove_anchor(
    origin: OriginFor<T>,
    asset: AssetId,
) -> DispatchResult;

// Управление пулами
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

// Управление оракулами
pub fn reset_token_ema(
    origin: OriginFor<T>,
    token: AssetId,
    new_price: FixedU128,
) -> DispatchResult;

pub fn force_ema_update(
    origin: OriginFor<T>,
    tokens: Vec<AssetId>,
) -> DispatchResult;

// Обновление конфигурации
pub fn update_config(
    origin: OriginFor<T>,
    new_config: SystemConfig<T>,
) -> DispatchResult;

pub fn set_token_override(
    origin: OriginFor<T>,
    token: AssetId,
    override_config: TokenConfigOverride,
) -> DispatchResult;

// Аварийные механизмы
pub fn emergency_pause(
    origin: OriginFor<T>,
) -> DispatchResult;

pub fn emergency_resume(
    origin: OriginFor<T>,
    pools: Vec<(AssetId, AssetId)>,
) -> DispatchResult;
```

### B.2 RPC-методы

```rust
// Запросы цен
pub fn get_token_price(token: AssetId) -> Option<FixedU128>;

// Симуляция маршрутов
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

// Мониторинг здоровья
pub fn get_pool_health(
    base: AssetId,
    quote: AssetId,
) -> Option<PoolHealth>;

pub fn get_healthy_pools() -> Vec<(AssetId, AssetId, PoolInfo)>;

// Аналитика
pub fn get_volume_24h(token: AssetId) -> Balance;
pub fn get_tvl_snapshot() -> Vec<(AssetId, Balance)>;
```

### B.3 События

```rust
#[pallet::event]
#[pallet::generate_deposit(pub(super) fn deposit_event)]
pub enum Event<T: Config> {
    /// Свап выполнен успешно
    SwapExecuted {
        who: T::AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        amount_out: Balance,
        route: BoundedVec<u8, ConstU32<128>>,
    },

    /// EMA токена обновлена
    TokenEmaUpdated {
        token: AssetId,
        price: FixedU128,
    },

    /// Пул поставлен на паузу говернансом
    PoolPaused {
        base: AssetId,
        quote: AssetId,
        until: Option<BlockNumber>,
    },

    /// Пул возобновлён
    PoolResumed {
        base: AssetId,
        quote: AssetId,
    },

    /// Опора добавлена
    AnchorAdded {
        asset: AssetId,
    },

    /// Опора удалена
    AnchorRemoved {
        asset: AssetId,
    },

    /// EMA токена сброшена вручную
    EmaReset {
        token: AssetId,
        new_price: FixedU128,
    },

    /// Конфигурация обновлена
    ConfigUpdated {
        field: BoundedVec<u8, ConstU32<32>>,
    },

    /// Аварийная пауза активирована
    EmergencyPause,

    /// Работа возобновлена после аварии
    EmergencyResume {
        pools_count: u32,
    },

    /// Оценка маршрута завершена
    RouteEvaluated {
        from: AssetId,
        to: AssetId,
        best_score: FixedU128,
        routes_considered: u8,
    },
}
```

### B.4 Ошибки

```rust
#[pallet::error]
pub enum Error<T> {
    /// Активы идентичны
    IdenticalAssets,
    /// Сумма равна нулю
    ZeroAmount,
    /// Пул не найден
    PoolNotFound,
    /// Нет данных оракула по токену
    OracleNotFound,
    /// Недостаточно ликвидности в пуле
    InsufficientLiquidity,
    /// Недостаточная общая ликвидность по пулам
    InsufficientTotalLiquidity,
    /// Маршрут между активами не найден
    NoRouteFound,
    /// Превышено допустимое проскальзывание
    SlippageExceeded,
    /// Слишком много переходов
    TooManyHops,
    /// Опоры не сконфигурированы
    NoAnchorsConfigured,
    /// Достигнут максимум опор
    TooManyAnchors,
    /// Нет активных пулов для токена
    NoActivePools,
    /// Арифметическое переполнение
    MathOverflow,
    /// Ошибка адаптера пула
    AdapterError,
    /// Данные EMA устарели
    StaleEma,
    /// Слишком много маршрутов в Split-режиме
    TooManyRoutes,
    /// Некорректная конфигурация
    InvalidConfig,
    /// Переопределение токена не найдено
    OverrideNotFound,
}
```

## Приложение C: интерфейс адаптера пулов

````rust
/// Трейт интеграции различных типов пулов
pub trait PoolAdapter<AccountId, AssetId, Balance> {
    type Error: Into<Error>;

    /// Получить текущие резервы
    fn get_reserves(
        pool_id: PoolId,
        base: AssetId,
        quote: AssetId,
    ) -> Result<(Balance, Balance), Self::Error>;

    /// Посчитать ожидаемый выход для точного входа
    fn quote_exact_in(
        pool_id: PoolId,
        amount_in: Balance,
        from: AssetId,
        to: AssetId,
    ) -> Result<Balance, Self::Error>;

    /// Посчитать требуемый вход для точного выхода
    fn quote_exact_out(
        pool_id: PoolId,
        amount_out: Balance,
        from: AssetId,
        to: AssetId,
    ) -> Result<Balance, Self::Error>;

    /// Выполнить свап
    fn swap(
        pool_id: PoolId,
        who: &AccountId,
        from: AssetId,
        to: AssetId,
        amount_in: Balance,
        min_amount_out: Balance,
    ) -> Result<Balance, Self::Error>;

    /// Получить тип пула
    fn pool_type(pool_id: PoolId) -> PoolType;

    /// Запросить долю POL (опционально)
    fn pol_share(pool_id: PoolId) -> Option<Permill> {
        None
    }

    /// Проверить, принимает ли пул внешние свапы
    fn is_external(pool_id: PoolId) -> bool {
        false
    }
}

pub enum PoolType {
    XYK,
    UTBC,
    External(BoundedVec<u8, ConstU32<32>>),
}

/// Адаптер пула с постоянным произведением XYK
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
        // Запросить паллет XYK
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

        // Формула XYK: out = (in * 997 * reserve_out) / (reserve_in * 1000 + in * 997)
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

## Приложение D: чек-лист развёртывания

### D.1 Перед развёртыванием

- [ ] **Аудит кода**: завершён независимой организацией
- [ ] **Формальная верификация**: ключевые инварианты доказаны
- [ ] **Деплой на тестнет**: не менее 3 месяцев работы
- [ ] **Нагрузочное тестирование**: подтверждена производительность на целевом масштабе
- [ ] **Документация**: описаны все публичные интерфейсы
- [ ] **Говернанс-процедуры**: определён процесс корректировки параметров
- [ ] **Аварийные процедуры**: задокументирован план реагирования на инциденты
- [ ] **Мониторинг**: готовность Prometheus + Grafana
- [ ] **Алертинг**: интеграция с PagerDuty/Slack

### D.2 Последовательность запуска

**Фаза 0: генезис (блок 0)**

```rust
// Инициализация с консервативными параметрами
GenesisConfig {
    import_pools: existing_dex_pools,
    initial_anchors: vec![NATIVE],  // одна опора на старте
    config: SystemConfig {
        ema_alpha: FixedU128::from_rational(1, 100), // 0.01 — сильное сглаживание
        min_liquidity: 50_000,  // высокий порог
        ema_ttl: 30,
        route_mode: RouteMode::Single,
        internal_only: true,
        success_threshold: Permill::from_percent(70),
        slippage_cap: Permill::from_percent(5),
    },
}
```

**Фаза 1: наблюдение (недели 1-2)**

- Мониторить схождение EMA
- Проверять метрики здоровья
- Сопоставлять с результатами легаси-маршрутизатора
- Торговля отключена

**Фаза 2: ограниченная торговля (недели 3-4)**

- Разрешить свапы белому списку
- Лимит дневного объёма 5% от TVL
- Круглосуточный мониторинг дежурной командой

**Фаза 3: постепенный запуск (недели 5-8)**

- Увеличивать лимиты объёма на 10% еженедельно
- Добавить вторую опору (DOT или стейблкоин)
- Включить публичный доступ с ограничением по ставкам

**Фаза 4: полная эксплуатация (9-я неделя и далее)**

- Снять лимиты
- Добавить оставшиеся опоры
- Рассмотреть активацию Split-режима
- Оценить интеграцию внешних пулов

### D.3 После запуска

- [ ] **Обзор через неделю**: анализ всех метрик, выявление проблем
- [ ] **Аудит через месяц**: внешняя проверка поведения системы
- [ ] **Оптимизация через квартал**: настройка параметров по данным
- [ ] **Непрерывный мониторинг**: постоянное улучшение процессов

## Приложение E: руководство по устранению неполадок

### E.1 Типовые проблемы

| Симптом                           | Возможная причина                     | Решение                                       |
| --------------------------------- | ------------------------------------- | --------------------------------------------- |
| Высокое расхождение EMA           | Недостаточная ликвидность             | Повысить порог `min_liquidity`                |
| Маршруты всегда через одну опору  | Несбалансированная ликвидность опор   | Добавить/ребалансировать пулы для других опор |
| Частые отступления                | Пулы малы для текущего объёма         | Увеличить резервы или снизить нагрузку        |
| Предупреждения об устаревании EMA | Проблемы оффчейн-воркера              | Проверить конфигурацию и логи воркеров        |
| Маршруты не находятся             | Все пулы нездоровы                    | Аварийно возобновить здоровые пулы            |
| Высокое проскальзывание           | Низкая ликвидность или крупные сделки | Делить ордера или добавлять ликвидность       |

### E.2 Процедуры отладки

```rust
// Проверить состояние системы
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

// Симуляция маршрута без исполнения
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

### E.3 Процедуры восстановления

**Сценарий: массовые сбои пулов**

```bash
# 1. Найти здоровые пулы
curl http://localhost:9933/rpc/axial_router/healthy_pools

# 2. При необходимости — аварийная пауза
polkadot-js-api tx.axialRouter.emergencyPause() --sudo

# 3. Возобновить конкретные пулы
polkadot-js-api tx.axialRouter.emergencyResume([
    [ASSET_A, NATIVE],
    [ASSET_B, NATIVE],
]) --sudo

# 4. Форсировать обновления EMA
polkadot-js-api tx.axialRouter.forceEmaUpdate([ASSET_A, ASSET_B]) --sudo
```

**Сценарий: расхождение EMA**

```bash
# 1. Проверить текущее состояние
curl http://localhost:9933/rpc/axial_router/token_price/ASSET_A

# 2. Рассчитать справедливую цену из пулов
python scripts/calculate_fair_price.py ASSET_A

# 3. При необходимости сбросить EMA
polkadot-js-api tx.axialRouter.resetTokenEma(
    ASSET_A,
    NEW_PRICE
) --sudo

# 4. Отслеживать схождение
watch 'curl http://localhost:9933/rpc/axial_router/token_price/ASSET_A'
```

## Приложение F: советы по оптимизации производительности

### F.1 Оптимизация хранения

```rust
// Используйте ограниченные коллекции
type MaxPoolsPerToken = ConstU32<20>;
type MaxActiveRoutes = ConstU32<5>;

// Кэшируйте часто используемые данные
#[pallet::storage]
pub type RecentRoutes<T> = StorageMap<
    _,
    Blake2_128Concat,
    (AssetId, AssetId),
    BoundedVec<Route, MaxActiveRoutes>,
    ValueQuery,
>;

// Очищайте устаревшие данные в хуках
fn on_finalize(block: BlockNumber) {
    // Удалить пулы без активности 1000 блоков
    Self::prune_inactive_pools(block);
}
```

### F.2 Оптимизация вычислений

```rust
// Пакетное обновление EMA
pub fn batch_update_emas(
    tokens: Vec<AssetId>,
) -> Result<u32, Error> {
    let mut updated = 0;
    for token in tokens.iter().take(10) {  // ограничение на вызов
        if Self::update_token_ema(*token).is_ok() {
            updated += 1;
        }
    }
    Ok(updated)
}

// Ленивое вычисление маршрутов
pub fn get_or_compute_route(
    from: AssetId,
    to: AssetId,
    amount: Balance,
) -> Result<Route, Error> {
    // Проверить кэш
    if let Some(cached) = RecentRoutes::<T>::get((from, to)).first() {
        if Self::is_route_still_valid(cached) {
            return Ok(cached.clone());
        }
    }

    // Посчитать и сохранить
    let route = Self::find_best_route(from, to, amount)?;
    RecentRoutes::<T>::mutate((from, to), |routes| {
        routes.try_push(route.clone()).ok();
    });
    Ok(route)
}
```

### F.3 Снижение затрат веса

- **Ранние проверки**: быстро отклоняйте неверные входы
- **Батчи**: группируйте связанные изменения состояния
- **Ленивая загрузка**: получайте только необходимые данные
- **Эффективная арифметика**: используйте целочисленные операции
- **Чтения из хранилища**: минимизируйте повторные обращения через кэширование

---

**Версия**: 1.0.0
**Дата**: Октябрь 2025
**Лицензия**: MIT
````
