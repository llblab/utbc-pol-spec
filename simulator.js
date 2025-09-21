// @ts-check

/**
 * @name `UTBC+POL` Simulator
 * @note This simulator is not a production-ready implementation, but rather serves for preliminary economic testing, parameter optimization, and business logic formalization.
 * @units Balances and prices use `PRECISION` (10^12) for accuracy. All fractional values (fees, slopes, shares) use `PPM` (Parts Per Million, 10^6) and require a '_ppm' suffix in naming.
 * @version 1.2.0
 * @module simulator.js
 */

/** @typedef {{ user_ppm: bigint, pol_ppm: bigint, treasury_ppm: bigint, team_ppm: bigint }} ShareConfig */
/** @typedef {{ price_initial: bigint, slope_ppm: bigint, fee_xyk_ppm: bigint, fee_router_ppm: bigint, min_trade_foreign: bigint, min_initial_foreign: bigint, shares: ShareConfig }} SystemConfig */
/** @typedef {{ fee_ppm: bigint }} XykPoolConfig */
/** @typedef {{ lp_minted: bigint, native_used: bigint, foreign_used: bigint, native_rest: bigint, foreign_rest: bigint }} LiquidityResult */
/** @typedef {XykPool | SmartRouter} Swapper */
/** @typedef {{ price_initial: bigint, slope_ppm: bigint, shares: ShareConfig }} UtbcMinterConfig */
/** @typedef {{ min_trade_foreign: bigint }} FeeManagerConfig */
/** @typedef {{ fee_router_ppm: bigint, min_trade_foreign: bigint, min_initial_foreign: bigint }} SmartRouterConfig */

export const DECIMALS = 12n;
export const PRECISION = 10n ** DECIMALS;
export const PPM = 1_000_000n;

export const DEFAULT_CONFIG = /** @type {SystemConfig} */ ({
  min_initial_foreign: 100n * PRECISION,
  min_trade_foreign: PRECISION / 100n,
  price_initial: PRECISION / 1_000n,
  slope_ppm: 1_000n,
  fee_xyk_ppm: 3_000n,
  fee_router_ppm: 2_000n,
  shares: {
    user_ppm: 333_333n,
    pol_ppm: 333_333n,
    treasury_ppm: 222_222n,
    team_ppm: 111_112n,
  },
});

export class BigMath {
  static mul_div(
    /** @type {bigint} */ a,
    /** @type {bigint} */ b,
    /** @type {bigint} */ c,
  ) {
    if (c === 0n) {
      throw new Error("Division by zero");
    }
    return (a * b) / c;
  }

  static div_ceil(/** @type {bigint} */ a, /** @type {bigint} */ b) {
    if (b === 0n) {
      throw new Error("Division by zero");
    }
    return a % b === 0n ? a / b : a / b + 1n;
  }

  static isqrt(/** @type {bigint} */ n) {
    if (n < 0n) {
      throw new Error("Square root of negative number");
    }
    if (n < 2n) {
      return n;
    }
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + n / x) / 2n;
    }
    return x;
  }

  static min(/** @type {bigint} */ a, /** @type {bigint} */ b) {
    return a < b ? a : b;
  }

  static max(/** @type {bigint} */ a, /** @type {bigint} */ b) {
    return a > b ? a : b;
  }

  static abs(/** @type {bigint} */ a) {
    return a < 0n ? -a : a;
  }

  static calculate_swap_output(
    /** @type {bigint} */ amount_in,
    /** @type {bigint} */ reserve_in,
    /** @type {bigint} */ reserve_out,
    /** @type {bigint} */ fee_ppm,
  ) {
    if (amount_in <= 0n || reserve_in <= 0n || reserve_out <= 0n) {
      return 0n;
    }
    const amount_in_with_fee = amount_in * (PPM - fee_ppm);
    const numerator = amount_in_with_fee * reserve_out;
    const denominator = reserve_in * PPM + amount_in_with_fee;
    return numerator / denominator;
  }
}

export class XykPool {
  constructor(/** @type {XykPoolConfig} */ config) {
    if (config.fee_ppm >= PPM) {
      throw new Error("Fee must be < 100%");
    }
    this.fee_ppm = config.fee_ppm;
    this.reserve_native = 0n;
    this.reserve_foreign = 0n;
    this.supply_lp = 0n;
  }

  get_price() {
    if (this.reserve_native === 0n) {
      throw new Error("Cannot calculate price with zero native reserves");
    }
    if (this.reserve_foreign === 0n) {
      throw new Error("Cannot calculate price with zero foreign reserves");
    }
    return BigMath.mul_div(
      this.reserve_foreign,
      PRECISION,
      this.reserve_native,
    );
  }

  has_liquidity() {
    return this.reserve_native > 0n && this.reserve_foreign > 0n;
  }

  get_out_native(/** @type {bigint} */ foreign) {
    if (foreign <= 0n || !this.has_liquidity()) {
      return 0n;
    }
    return BigMath.calculate_swap_output(
      foreign,
      this.reserve_foreign,
      this.reserve_native,
      this.fee_ppm,
    );
  }

  get_out_foreign(/** @type {bigint} */ native) {
    if (native <= 0n || !this.has_liquidity()) {
      return 0n;
    }
    return BigMath.calculate_swap_output(
      native,
      this.reserve_native,
      this.reserve_foreign,
      this.fee_ppm,
    );
  }

  add_liquidity(/** @type {bigint} */ native, /** @type {bigint} */ foreign) {
    if (native <= 0n || foreign <= 0n) {
      throw new Error("Amounts must be positive");
    }
    if (!this.has_liquidity()) {
      const lp_minted = BigMath.isqrt(native * foreign);
      if (lp_minted === 0n) {
        throw new Error("Insufficient initial liquidity");
      }
      this.reserve_native = native;
      this.reserve_foreign = foreign;
      this.supply_lp = lp_minted;
      return {
        lp_minted,
        native_used: native,
        foreign_used: foreign,
        native_rest: 0n,
        foreign_rest: 0n,
      };
    }
    const lp_from_native = BigMath.mul_div(
      native,
      this.supply_lp,
      this.reserve_native,
    );
    const lp_from_foreign = BigMath.mul_div(
      foreign,
      this.supply_lp,
      this.reserve_foreign,
    );
    const lp_minted = BigMath.min(lp_from_native, lp_from_foreign);
    if (lp_minted === 0n) {
      throw new Error("Insufficient liquidity provided");
    }
    const native_used = BigMath.mul_div(
      this.reserve_native,
      lp_minted,
      this.supply_lp,
    );
    const foreign_used = BigMath.mul_div(
      this.reserve_foreign,
      lp_minted,
      this.supply_lp,
    );
    this.reserve_native += native_used;
    this.reserve_foreign += foreign_used;
    this.supply_lp += lp_minted;
    return {
      lp_minted,
      native_used,
      foreign_used,
      native_rest: native - native_used,
      foreign_rest: foreign - foreign_used,
    };
  }

  swap_native_to_foreign(
    /** @type {bigint} */ native,
    /** @type {bigint} */ foreign_min = 0n,
  ) {
    if (native <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (!this.has_liquidity()) {
      throw new Error("No liquidity");
    }
    const foreign_out = this.get_out_foreign(native);
    if (foreign_out < foreign_min) {
      throw new Error("Slippage exceeded");
    }
    return this.#execute_swap(native, foreign_out, true);
  }

  swap_foreign_to_native(
    /** @type {bigint} */ foreign,
    /** @type {bigint} */ native_min = 0n,
  ) {
    if (foreign <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (!this.has_liquidity()) {
      throw new Error("No liquidity");
    }
    const native_out = this.get_out_native(foreign);
    if (native_out < native_min) {
      throw new Error("Slippage exceeded");
    }
    return this.#execute_swap(foreign, native_out, false);
  }

  #execute_swap(
    /** @type {bigint} */ amount_in,
    /** @type {bigint} */ amount_out,
    /** @type {boolean} */ native_to_foreign,
  ) {
    const price_before = this.get_price();
    if (native_to_foreign) {
      this.reserve_native += amount_in;
      this.reserve_foreign -= amount_out;
    } else {
      this.reserve_foreign += amount_in;
      this.reserve_native -= amount_out;
    }
    const price_after = this.get_price();
    const price_impact_ppm =
      price_before > 0n
        ? BigMath.mul_div(
            BigMath.abs(price_after - price_before),
            PPM,
            price_before,
          )
        : 0n;
    return {
      native_in: native_to_foreign ? amount_in : 0n,
      native_out: native_to_foreign ? 0n : amount_out,
      foreign_in: native_to_foreign ? 0n : amount_in,
      foreign_out: native_to_foreign ? amount_out : 0n,
      price_before,
      price_after,
      price_impact_ppm,
    };
  }
}

/**
 * `Protocol-Owned Liquidity` Manager
 */
export class PolManager {
  constructor(/** @type {XykPool} */ xyk_pool) {
    this.xyk_pool = xyk_pool;
    this.swapper = /** @type {Swapper} */ (xyk_pool);
    this.balance_lp = 0n;
    this.contributed_native = 0n;
    this.contributed_foreign = 0n;
    this.buffer_native = 0n;
    this.buffer_foreign = 0n;
  }

  set_swapper(/** @type {Swapper} */ swapper) {
    this.swapper = swapper;
  }

  add_liquidity(/** @type {bigint} */ native, /** @type {bigint} */ foreign) {
    if (
      native === 0n &&
      foreign === 0n &&
      this.buffer_native === 0n &&
      this.buffer_foreign === 0n
    ) {
      return this.#create_liquidity_result(0n, 0n, 0n);
    }
    // Branch 1: Pool initialization (first UTBC mint ONLY)
    // - Happens exactly once when pool doesn't exist
    // - Uses direct XYK add_liquidity with all available tokens
    // - Sets initial price based on POL allocation from first mint
    // - Does NOT use Zap strategy (no swapping, no ratio matching)
    if (!this.xyk_pool.has_liquidity()) {
      const init_result = this.#try_initialize_pool(native, foreign);
      if (init_result.success) {
        // Pool initialized successfully with first mint's POL allocation
        return this.#create_liquidity_result(
          init_result.lp_minted,
          init_result.native_used,
          init_result.foreign_used,
        );
      } else {
        // Initialization failed or insufficient tokens - everything stays in buffers
        return this.#create_liquidity_result(0n, 0n, 0n);
      }
    }
    // Branch 2: Zap strategy for existing pool (all subsequent mints)
    // - Uses AllInZap to maximize liquidity depth
    // - Maintains pool ratio, swaps excess foreign through router
    // - Sophisticated capital efficiency optimization
    const zap_result = this.#execute_zap_and_update(native, foreign);
    return this.#create_liquidity_result(
      zap_result.lp_minted,
      zap_result.native_used,
      zap_result.foreign_used,
    );
  }

  #create_liquidity_result(
    /** @type {bigint} */ lp_minted,
    /** @type {bigint} */ native_used,
    /** @type {bigint} */ foreign_used,
  ) {
    return {
      lp_minted,
      native_used,
      foreign_used,
      buffered_native: this.buffer_native,
      buffered_foreign: this.buffer_foreign,
    };
  }

  /**
   * Initialize XYK pool with first mint's POL allocation
   * This is NOT a zap operation - it's direct pool bootstrapping
   * Only called once when pool doesn't exist yet
   */
  #try_initialize_pool(
    /** @type {bigint} */ native,
    /** @type {bigint} */ foreign,
  ) {
    const total_native = this.buffer_native + native;
    const total_foreign = this.buffer_foreign + foreign;
    if (total_native === 0n || total_foreign === 0n) {
      this.buffer_native = total_native;
      this.buffer_foreign = total_foreign;
      return {
        success: false,
        lp_minted: 0n,
        native_used: 0n,
        foreign_used: 0n,
      };
    }
    try {
      const result = this.xyk_pool.add_liquidity(total_native, total_foreign);
      this.balance_lp += result.lp_minted;
      this.contributed_native += result.native_used;
      this.contributed_foreign += result.foreign_used;
      this.buffer_native = result.native_rest;
      this.buffer_foreign = result.foreign_rest;
      return {
        success: true,
        lp_minted: result.lp_minted,
        native_used: result.native_used,
        foreign_used: result.foreign_used,
      };
    } catch {
      this.buffer_native = total_native;
      this.buffer_foreign = total_foreign;
      return {
        success: false,
        lp_minted: 0n,
        native_used: 0n,
        foreign_used: 0n,
      };
    }
  }

  /**
   * Executes the "zap" mechanism for existing pools:
   * 1. Adds balanced liquidity while preserving the pool's ratio
   * 2. Swaps any excess foreign tokens for native tokens
   * 3. Keeps tokens in the buffers for future use
   * This maximizes LP depth while handling imbalanced inputs.
   */
  #execute_zap_and_update(
    /** @type {bigint} */ native,
    /** @type {bigint} */ foreign,
  ) {
    const total_native = this.buffer_native + native;
    const total_foreign = this.buffer_foreign + foreign;
    let native_rest = total_native;
    let foreign_rest = total_foreign;
    let lp_minted = 0n;
    let native_used = 0n;
    let foreign_used = 0n;
    // Step 1: Add balanced liquidity if we have both tokens
    if (native_rest > 0n && foreign_rest > 0n) {
      // Calculate ratio-preserving amounts
      const foreign_by_native = BigMath.mul_div(
        native_rest,
        this.xyk_pool.reserve_foreign,
        this.xyk_pool.reserve_native,
      );
      const [native_to_add, foreign_to_add] =
        foreign_by_native <= foreign_rest
          ? [native_rest, foreign_by_native]
          : [
              BigMath.mul_div(
                foreign_rest,
                this.xyk_pool.reserve_native,
                this.xyk_pool.reserve_foreign,
              ),
              foreign_rest,
            ];
      if (native_to_add > 0n && foreign_to_add > 0n) {
        try {
          const add_result = this.xyk_pool.add_liquidity(
            native_to_add,
            foreign_to_add,
          );
          lp_minted = add_result.lp_minted;
          native_used = add_result.native_used;
          foreign_used = add_result.foreign_used;
          native_rest -= add_result.native_used;
          foreign_rest -= add_result.foreign_used;
        } catch {
          // Liquidity addition failed, keep everything for swap attempt
        }
      }
    }
    // Step 2: Swap excess foreign for native if needed
    if (foreign_rest > 0n) {
      try {
        const swap_result = this.swapper.swap_foreign_to_native(foreign_rest);
        native_rest += swap_result.native_out;
        foreign_used += foreign_rest;
        foreign_rest = 0n;
      } catch {
        // Swap failed, keep foreign in buffer
      }
    }
    this.balance_lp += lp_minted;
    this.contributed_native += native_used;
    this.contributed_foreign += foreign_used;
    this.buffer_native = native_rest;
    this.buffer_foreign = foreign_rest;
    return {
      lp_minted,
      native_used,
      foreign_used,
    };
  }
}

/**
 * `Unidirectional Token Bonding Curve` Minter
 */
export class UtbcMinter {
  constructor(
    /** @type {PolManager} */ pol_manager,
    /** @type {UtbcMinterConfig} */ config,
  ) {
    if (config.price_initial <= 0n) {
      throw new Error("Initial price must be positive");
    }
    if (config.slope_ppm < 0n) {
      throw new Error("Slope must be non-negative");
    }
    this.price_initial = config.price_initial;
    this.slope_ppm = config.slope_ppm;
    this.shares = config.shares;
    this.pol_manager = pol_manager;
    this.supply = 0n;
    this.treasury = 0n;
    this.team = 0n;
    const sum_shares = Object.values(this.shares).reduce((a, b) => a + b, 0n);
    if (sum_shares !== PPM) {
      throw new Error(`Shares must sum to ${PPM}, got ${sum_shares}`);
    }
  }

  get_price() {
    const slope_component = BigMath.mul_div(
      BigMath.mul_div(this.price_initial, this.slope_ppm, PPM),
      this.supply,
      PRECISION,
    );
    return this.price_initial + slope_component;
  }

  calculate_mint(/** @type {bigint} */ foreign) {
    if (foreign <= 0n) {
      return 0n;
    }
    const price_initial = this.price_initial;
    const slope = this.slope_ppm;
    const supply = this.supply;
    if (slope === 0n) {
      return BigMath.mul_div(foreign, PRECISION, price_initial);
    }
    const a = price_initial * slope * PRECISION;
    const b = 2n * price_initial * (slope * supply + PPM * PRECISION);
    const c = -2n * PPM * foreign;
    const discriminant = b * b - 4n * a * c;
    if (discriminant < 0n) {
      return 0n;
    }
    const sqrt_discriminant = BigMath.isqrt(discriminant);
    const numerator = sqrt_discriminant - b;
    if (numerator <= 0n) {
      return 0n;
    }
    const x_base = numerator / (2n * a);
    return x_base * PRECISION;
  }

  mint_native(/** @type {bigint} */ foreign_in) {
    const price_before = this.get_price();
    const total_native = this.calculate_mint(foreign_in);
    if (total_native === 0n) {
      throw new Error("Insufficient amount");
    }
    this.supply += total_native;
    const distribution = this.#distribute(total_native);
    this.treasury += distribution.treasury;
    this.team += distribution.team;
    const pol_result = this.pol_manager.add_liquidity(
      distribution.pol,
      foreign_in,
    );
    const price_after = this.get_price();
    return {
      foreign_in,
      total_native,
      user_native: distribution.user,
      pol_native: distribution.pol,
      treasury_native: distribution.treasury,
      team_native: distribution.team,
      price_before,
      price_after,
      pol: pol_result,
    };
  }

  get_mint_quote(/** @type {bigint} */ foreign) {
    const minted = this.calculate_mint(foreign);
    if (minted === 0n) {
      return null;
    }
    return {
      minted,
      ...this.#distribute(minted),
    };
  }

  burn_native(/** @type {bigint} */ amount) {
    if (amount <= 0n) {
      throw new Error("Burn amount must be positive");
    }
    if (this.supply < amount) {
      throw new Error(
        `Insufficient supply for burn: ${this.supply} < ${amount}`,
      );
    }
    const supply_before = this.supply;
    this.supply -= amount;
    return {
      native_burned: amount,
      supply_before,
      supply_after: this.supply,
    };
  }

  #distribute(/** @type {bigint} */ minted) {
    const user = BigMath.mul_div(minted, this.shares.user_ppm, PPM);
    const pol = BigMath.mul_div(minted, this.shares.pol_ppm, PPM);
    const treasury = BigMath.mul_div(minted, this.shares.treasury_ppm, PPM);
    const team = BigMath.mul_div(minted, this.shares.team_ppm, PPM);
    return { user, pol, treasury, team };
  }
}

export class FeeManager {
  constructor(
    /** @type {XykPool} */ xyk_pool,
    /** @type {UtbcMinter} */ utbc_minter,
    /** @type {FeeManagerConfig} */ config,
  ) {
    this.xyk_pool = xyk_pool;
    this.utbc_minter = utbc_minter;
    this.min_trade_foreign = config.min_trade_foreign;
    this.buffer_foreign = 0n;
    this.total_native_burned = 0n;
    this.total_foreign_swapped = 0n;
  }

  receive_fee_native(/** @type {bigint} */ native) {
    if (native <= 0n) return;
    const result = this.#execute_burn(native, 0n);
    this.total_native_burned += result.native_burned;
  }

  receive_fee_foreign(/** @type {bigint} */ foreign) {
    if (foreign <= 0n) return;
    const total_foreign = this.buffer_foreign + foreign;
    const result = this.#execute_burn(0n, total_foreign);
    this.buffer_foreign = result.foreign_buffered;
    this.total_native_burned += result.native_burned;
    this.total_foreign_swapped += result.foreign_swapped;
  }

  #execute_burn(
    /** @type {bigint} */ native_fee,
    /** @type {bigint} */ foreign_fee,
  ) {
    let result = {
      native_burned: 0n,
      foreign_swapped: 0n,
      foreign_buffered: foreign_fee,
      native_to_burn: native_fee,
      foreign_to_swap: 0n,
    };
    if (
      foreign_fee >= this.min_trade_foreign &&
      this.xyk_pool.has_liquidity()
    ) {
      try {
        // Execute swap using XYK pool only
        const swap_result = this.xyk_pool.swap_foreign_to_native(foreign_fee);
        result.foreign_to_swap = foreign_fee;
        result.foreign_swapped = foreign_fee;
        result.foreign_buffered = 0n;
        result.native_to_burn += swap_result.native_out;
      } catch {
        // Swap failed, keep foreign in buffer
      }
    }
    if (result.native_to_burn > 0n) {
      this.utbc_minter.burn_native(result.native_to_burn);
      result.native_burned = result.native_to_burn;
    }
    return result;
  }
}

export class SmartRouter {
  constructor(
    /** @type {XykPool} */ xyk_pool,
    /** @type {UtbcMinter} */ utbc_minter,
    /** @type {FeeManager} */ fee_manager,
    /** @type {SmartRouterConfig} */ config,
  ) {
    this.xyk_pool = xyk_pool;
    this.utbc_minter = utbc_minter;
    this.fee_manager = fee_manager;
    this.fee_router_ppm = config.fee_router_ppm;
    this.min_trade_foreign = config.min_trade_foreign;
    this.min_initial_foreign = config.min_initial_foreign;
  }

  get_best_route(/** @type {bigint} */ foreign) {
    if (foreign <= 0n) {
      return null;
    }
    const { fee, net } = this.#calculate_fee(foreign);
    const utbc_quote = this.utbc_minter.get_mint_quote(net);
    const utbc_out = utbc_quote?.user ?? 0n;
    const xyk_out = this.xyk_pool.has_liquidity()
      ? this.xyk_pool.get_out_native(net)
      : 0n;
    const utbc_viable = utbc_quote && utbc_out > 0n;
    const xyk_viable = xyk_out > 0n;
    if (!utbc_viable && !xyk_viable) {
      return {
        best: "NONE",
        native_out: 0n,
        foreign_in: foreign,
        foreign_net: net,
        foreign_fee: fee,
      };
    }
    const use_utbc = utbc_viable && utbc_out >= xyk_out;
    return {
      best: use_utbc ? "UTBC" : "XYK",
      foreign_in: foreign,
      native_out: use_utbc ? utbc_out : xyk_out,
      foreign_net: net,
      foreign_fee: fee,
    };
  }

  swap_foreign_to_native(
    /** @type {bigint} */ foreign_in,
    /** @type {bigint} */ native_min = 0n,
  ) {
    this.#validate_swap_input(
      foreign_in,
      this.min_trade_foreign,
      `Amount below minimum threshold (${this.min_trade_foreign} foreign)`,
    );
    // Check if this is the first mint and pool is not initialized
    if (
      !this.xyk_pool.has_liquidity() &&
      foreign_in < this.min_initial_foreign
    ) {
      throw new Error(
        `Initial mint requires minimum ${this.min_initial_foreign} foreign tokens`,
      );
    }
    const { fee, net } = this.#calculate_fee(foreign_in);
    if (net <= 0n) {
      throw new Error("Amount too small");
    }
    const { use_utbc } = this.#select_best_route(net, native_min);
    this.fee_manager.receive_fee_foreign(fee);
    return use_utbc
      ? this.#execute_utbc_route(net, foreign_in, fee)
      : this.#execute_xyk_route(net, foreign_in, fee, native_min);
  }

  swap_native_to_foreign(
    /** @type {bigint} */ native_in,
    /** @type {bigint} */ foreign_min = 0n,
  ) {
    this.#validate_swap_input(native_in, 1n, "Amount must be positive");
    if (!this.xyk_pool.has_liquidity()) {
      throw new Error(
        "Pool not initialized. Cannot sell native tokens before initial liquidity",
      );
    }
    const price_spot = this.xyk_pool.get_price();
    if (price_spot === 0n) {
      throw new Error("Invalid pool state: no native reserves");
    }
    const native_as_foreign = BigMath.mul_div(native_in, price_spot, PRECISION);
    if (native_as_foreign < this.min_trade_foreign) {
      throw new Error(
        `Amount below minimum threshold (${this.min_trade_foreign} foreign equivalent)`,
      );
    }
    const swap_result = this.xyk_pool.swap_native_to_foreign(
      native_in,
      foreign_min,
    );
    return {
      route: "XYK",
      foreign_out: swap_result.foreign_out,
      native_in: native_in,
      native_fee: 0n,
      native_net: native_in,
      price_before: swap_result.price_before,
      price_after: swap_result.price_after,
      price_impact_ppm: swap_result.price_impact_ppm,
    };
  }

  #validate_swap_input(
    /** @type {bigint} */ amount,
    /** @type {bigint} */ min_threshold,
    /** @type {string} */ error_msg,
  ) {
    if (amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (amount < min_threshold) {
      throw new Error(error_msg);
    }
  }

  #select_best_route(
    /** @type {bigint} */ net,
    /** @type {bigint} */ native_min,
  ) {
    const utbc_quote = this.utbc_minter.get_mint_quote(net);
    const utbc_out = utbc_quote?.user ?? 0n;
    const xyk_out = this.xyk_pool.has_liquidity()
      ? this.xyk_pool.get_out_native(net)
      : 0n;
    const can_utbc = utbc_quote && utbc_out >= native_min;
    const can_xyk = this.xyk_pool.has_liquidity() && xyk_out >= native_min;
    if (!can_utbc && !can_xyk) {
      throw new Error("Slippage exceeded");
    }
    return {
      use_utbc: can_utbc && utbc_out >= xyk_out,
      utbc_quote,
      xyk_out,
    };
  }

  #execute_utbc_route(
    /** @type {bigint} */ net,
    /** @type {bigint} */ foreign_in,
    /** @type {bigint} */ fee,
  ) {
    const mint_result = this.utbc_minter.mint_native(net);
    return {
      route: "UTBC",
      native_out: mint_result.user_native,
      foreign_in: foreign_in,
      foreign_net: net,
      foreign_fee: fee,
      price_before: mint_result.price_before,
      price_after: mint_result.price_after,
      pol: mint_result.pol,
    };
  }

  #execute_xyk_route(
    /** @type {bigint} */ net,
    /** @type {bigint} */ foreign_in,
    /** @type {bigint} */ fee,
    /** @type {bigint} */ native_min,
  ) {
    const swap_result = this.xyk_pool.swap_foreign_to_native(net, native_min);
    return {
      route: "XYK",
      native_out: swap_result.native_out,
      foreign_in: foreign_in,
      foreign_net: net,
      foreign_fee: fee,
      price_before: swap_result.price_before,
      price_after: swap_result.price_after,
      price_impact_ppm: swap_result.price_impact_ppm,
    };
  }

  #calculate_fee(/** @type {bigint} */ amount) {
    const fee = BigMath.mul_div(amount, this.fee_router_ppm, PPM);
    const net = amount - fee;
    return { fee, net };
  }
}

export const create_system = (
  /** @type {Partial<SystemConfig>} */ user_config,
) => {
  const config = { ...DEFAULT_CONFIG, ...user_config };
  const xyk_pool = new XykPool({ fee_ppm: config.fee_xyk_ppm });
  const pol_manager = new PolManager(xyk_pool);
  const utbc_minter = new UtbcMinter(pol_manager, {
    price_initial: config.price_initial,
    slope_ppm: config.slope_ppm,
    shares: config.shares,
  });
  const fee_manager = new FeeManager(xyk_pool, utbc_minter, {
    min_trade_foreign: config.min_trade_foreign,
  });
  const router = new SmartRouter(xyk_pool, utbc_minter, fee_manager, {
    fee_router_ppm: config.fee_router_ppm,
    min_trade_foreign: config.min_trade_foreign,
    min_initial_foreign: config.min_initial_foreign,
  });
  pol_manager.set_swapper(router);
  return { xyk_pool, pol_manager, utbc_minter, router, fee_manager };
};
