# `UTBC+POL`: Односторонняя токеновая бондинговая кривая + Ликвидность, принадлежащая протоколу

**Спецификация v1.2.0**

---

## Аннотация

`UTBC+POL` формирует самоусиливающуюся экономику токена, объединяя выпуск токенов с постоянным созданием ликвидности. Смарт-роутер сравнивает цены между односторонней бондинговой кривой и пулом вторичного рынка, обеспечивая оптимальное исполнение и при этом системно наращивая принадлежащую протоколу ликвидность, которую невозможно вывести. Комиссии роутера сжигаются, создавая дефляционное давление.

---

## 1. Обоснование дизайна

### 1.1 Ключевое нововведение

Традиционные запуски токенов требуют внешних поставщиков ликвидности, которые могут забрать средства в любой момент, создавая системный риск. `UTBC+POL` решает эту проблему, делая генерацию ликвидности частью выпуска токена — каждый минт автоматически добавляет перманентную ликвидность.

### 1.2 Свойства системы

- **Односторонний минтинг**: Токены создаются только через бондинговую кривую, обратного выкупа нет
- **Автоматическое формирование POL**: Каждый минт добавляет постоянную ликвидность в пул XYK
- **Инфраструктурная премия**: Пользователи получают больше токенов, пока протокол захватывает арбитраж
- **Самоподдерживающаяся система**: Не нужны внешние LP или эмиссия
- **Дефляционность**: Комиссии роутера системно сжигаются
- **Точность прежде всего**: Отсутствие потерь токенов за счёт обработки остатков

### 1.3 Состав «лего»

```
Bonding Curve + AMM Pool + Protocol Owned Liquidity = `UTBC+POL`
```

Даёт возникающие свойства:

- Самозапуск из нулевого состояния
- Множественные пути поиска цены
- Усиливающие механизмы

---

## 2. Техническая архитектура

### 2.1 Базовые типы

```rust
// Типы в духе Substrate для высокой точности
type Balance = u128;  // Количество токенов
type Price = u128;    // Цена с масштабом PRECISION
type Permill = u32;   // Доли на миллион (0-1_000_000)

const Precision: u128 = 1_000_000_000_000;  // 10^12
```

### 2.2 Смарт-роутер

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

        // Сравниваем количество токенов, получаемых пользователем
        let tbc_output = BondingCurve::calculate_user_receives(foreign_net);
        let xyk_output = XykPool::get_output_amount(foreign_net);

        // Маршрутизируем по наилучшей цене для пользователя
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

### 2.3 Математика бондинговой кривой

```rust
struct BondingCurve;

impl BondingCurve {
    fn spot_price(supply: Balance) -> Price {
        let slope_contribution = SLOPE.mul_floor(supply);
        INITIAL_PRICE.saturating_add(slope_contribution)
    }

    fn calculate_mint(payment: Balance) -> Balance {
        // Случай постоянной цены
        if SLOPE.is_zero() {
            return payment
                .saturating_mul(Precision)
                .saturating_div(INITIAL_PRICE);
        }

        // Линейная кривая: решаем квадратное уравнение
        // Используем u256 для промежуточных вычислений, чтобы избежать переполнения
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

        // Формула квадратного уравнения с положительным корнем
        let discriminant = b.saturating_pow(2)
            .saturating_add(a.saturating_mul(c).saturating_mul(4u32.into()));
        let sqrt_disc = IntegerSquareRoot::integer_sqrt(discriminant);

        if sqrt_disc <= b {
            return 0;
        }

        let numerator = sqrt_disc.saturating_sub(b);
        let denominator = a.saturating_mul(2u32.into());

        // Безопасное приведение вниз после деления
        let result = numerator.saturating_div(denominator);
        result.try_into().unwrap_or(0)
    }

    fn calculate_user_receives(payment: Balance) -> Balance {
        let total = Self::calculate_mint(payment);
        USER_SHARE.mul_floor(total)
    }
}
```

### 2.4 Распределение токенов

```rust
struct Distribution;

impl Distribution {
    const USER: Permill = Permill::from_parts(333_333);      // 33,33%
    const POL: Permill = Permill::from_parts(333_333);       // 33,33%
    const TREASURY: Permill = Permill::from_parts(222_222);  // 22,22%
    const TEAM: Permill = Permill::from_parts(111_112);      // 11,11% + остаток

    fn mint_with_distribution(
        buyer: AccountId,
        payment: Balance
    ) -> Result<Balance, Error> {
        let total_minted = BondingCurve::calculate_mint(payment);

        // Считаем доли
        let user_amount = Self::calculate_share(total_minted, Self::USER);
        let pol_amount = Self::calculate_share(total_minted, Self::POL);
        let treasury_amount = Self::calculate_share(total_minted, Self::TREASURY);

        // Команда получает остаток для идеальной консервации
        let team_amount = total_minted
            .saturating_sub(user_amount)
            .saturating_sub(pol_amount)
            .saturating_sub(treasury_amount);

        // Выполняем переводы
        Token::transfer(&buyer, user_amount)?;
        Token::transfer(&TREASURY, treasury_amount)?;
        Token::transfer(&TEAM, team_amount)?;

        // Формируем POL через механизм zap
        PolManager::add_liquidity_with_zap(pol_amount, payment)?;

        Ok(user_amount)
    }

    fn calculate_share(amount: Balance, share: Permill) -> Balance {
        share.mul_floor(amount)
    }
}
```

### 2.5 Механизм «zap» для POL

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
        // Учитываем буферизированные суммы
        let total_native = native.saturating_add(Self::native_buffer());
        let total_foreign = foreign.saturating_add(Self::foreign_buffer());

        let (pool_native, pool_foreign) = XykPool::reserves();

        // Стадия запуска — накапливаем буфер, пока пул не инициализирован
        if pool_native == 0 || pool_foreign == 0 {
            Self::set_buffers(total_native, total_foreign);
            return Ok(());
        }

        // Рассчитываем сбалансированные объемы ликвидности
        let ratio = Self::calculate_ratio(pool_foreign, pool_native);
        let foreign_needed = Self::apply_ratio(total_native, ratio);

        if total_foreign >= foreign_needed {
            // Добавляем сбалансированную ликвидность
            let lp_tokens = XykPool::add_liquidity(
                total_native,
                foreign_needed
            )?;
            Protocol::hold_forever(lp_tokens);

            // Конвертируем излишек foreign в native
            let excess = total_foreign.saturating_sub(foreign_needed);
            Self::handle_excess_foreign(excess);
        } else {
            // Не хватает foreign — свопаем часть native
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

### 2.6 Механизм сжигания комиссий

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

### 2.7 Защита и валидация

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
        // Не позволяем вывести более 10% от резервов
        let max_out = reserve.saturating_mul(10) / 100;
        if amount_out > max_out {
            return Err(Error::InsufficientReserves);
        }
        Ok(())
    }
}
```

---

## 3. Экономическая модель

### 3.1 Динамика предложения

Предложение расширяется только когда TBC предлагает лучшую цену, чем вторичный рынок:

- Линейное ценообразование создаёт предсказуемую кривую стоимости
- Инфраструктурная премия обеспечивает устойчивое финансирование
- Нет произвольного выпуска или инфляции

### 3.2 Инфраструктурная премия

Когда пользователи покупают через TBC, они получают 33,3% от сминченных токенов — это БОЛЬШЕ, чем даёт вторичный рынок. Протокол сохраняет разницу как арбитражную прибыль, а не налог на пользователя:

```
Пример: XYK предлагает 100 токенов за 1 ETH
         TBC создаёт 303 токена за 1 ETH
         Пользователь получает 101 токен (выигрыш)
         Протокол сохраняет 202 токена (выигрыш)
```

### 3.3 Потоки ценности

```
Покупка пользователя → Минт → Рост POL → Более глубокая ликвидность → Лучшие цены
                     |       ↘ Казна → Развитие → Рост протокола
                     |        ↘ Команда → Согласование → Устойчивость
                      ↘ Сжигание → Дефицит → Рост стоимости
```

---

## 4. Конфигурация

```rust
struct Config {
    // Бондинговая кривая
    initial_price: Price,
    slope: Permill,

    // Доли распределения (в сумме 1_000_000)
    user_share: Permill,        // from_parts(333_333)
    pol_share: Permill,         // from_parts(333_333)
    treasury_share: Permill,    // from_parts(222_222)
    team_share: Permill,        // from_parts(111_112)

    // Комиссии
    router_fee: Permill,        // from_parts(2_000) = 0,2%
    xyk_fee: Permill,           // from_parts(3_000) = 0,3%

    // Защита
    min_initial_mint: Balance,  // 100_000
    min_swap_amount: Balance,   // 1_000
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

## 5. Рекомендации по реализации

### 5.1 Требования к точности

- Использовать `u128` для всех типов `Balance`
- Применять `u256` для промежуточных вычислений, чтобы избежать переполнения
- Масштабировать цены с помощью `Precision` (10^12)
- Использовать `Permill` для всех процентов с `from_parts()` и `mul_floor()`
- Обеспечить обработку остатков для идеальной консервации токенов

### 5.2 Критические инварианты

1. **Консервация**: `minted = user + pol + treasury + team`
2. **Монотонность**: Цена на бондинговой кривой только растёт
3. **Ликвидность**: Токены POL хранятся навсегда, не выводятся
4. **Дефляция**: Сожжённые токены навсегда выводятся из обращения

### 5.3 Фокус тестирования

- Потери точности при операциях
- Переходы состояния буферов
- Граничные случаи на этапе инициализации пула
- Защита от переполнений в вычислениях
- Эффективность защиты от проскальзывания

---

## 6. Преимущества и компромиссы

**Преимущества:**

- Отсутствие риска «rug pull» благодаря постоянному POL
- Честный запуск с прозрачным линейным ценообразованием
- Самоподдерживающаяся модель без внешних зависимостей
- Множество согласованных механизмов мотивации
- Плавная деградация благодаря буферизации

**Компромиссы:**

- Более высокие затраты на газ из-за множественных операций
- Односторонняя конвертация ограничивает арбитраж
- Требуется начальный порог для запуска
- Сложнее по сравнению с простыми бондинговыми кривыми

---

## 7. Заключение

`UTBC+POL` радикально переосмысляет механику запуска токенов, сочетая выпуск с постоянной ликвидностью и превращая распределение в арбитражный доход. Система формирует устойчивую экономику, которая выравнивает интересы всех участников и решает проблему запуска за счёт системного строительства инфраструктуры.

---

## Журнал изменений

### v1.2.0 (сентябрь 2025)

- Введена защита стадии запуска
- Добавлен механизм сжигания комиссий
- Уточнена модель инфраструктурной премии
- Расширена документация механизма Zap

### v1.1.0 (сентябрь 2025)

- Улучшена экономическая модель с учётом эффективности Zap
- Разъяснено управление буферами в операциях POL

### v1.0.0 (июнь 2025)

- Представлена основная концепция

---

- **Версия**: 1.2.0
- **Дата**: сентябрь 2025
- **Автор**: Вячеслав Шебуняев
- **Лицензия**: MIT
