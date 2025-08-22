/**
 * UTBC+POL Simulator
 * @module simulator.js
 */

export const DECIMALS = 12n;
export const PRECISION = 10n ** DECIMALS;
export const PPM = 1_000_000n;

const DEFAULT_CONFIG = /** @type {SystemConfig} */ ({
  price_initial: 1_000_000_000n,
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

/** @typedef {{ user_ppm: bigint, pol_ppm: bigint, treasury_ppm: bigint, team_ppm: bigint }} ShareConfig */
/** @typedef {{ price_initial: bigint, slope_ppm: bigint, fee_xyk_ppm: bigint, fee_router_ppm: bigint, shares: ShareConfig }} SystemConfig */
/** @typedef {{ fee_ppm: bigint }} XykPoolConfig */
/** @typedef {{ lp_minted: bigint, native_used: bigint, foreign_used: bigint, native_rest: bigint, foreign_rest: bigint }} LiquidityResult */
/** @typedef {(xyk_pool: XykPool, native_amount: bigint, foreign_amount: bigint) => LiquidityResult} ZapExecute */
/** @typedef {{ execute: ZapExecute }} PolZapStrategy */
/** @typedef {{ price_initial: bigint, slope_ppm: bigint, shares: ShareConfig }} UtbcMinterConfig */
/** @typedef {{ fee_router_ppm: bigint }} SmartRouterConfig */

export const mul_div = (
  /** @type {bigint} */ a,
  /** @type {bigint} */ b,
  /** @type {bigint} */ c,
) => {
  if (c === 0n) {
    throw new Error("Division by zero");
  }
  return b === c ? a : (a * b) / c;
};

export const div_ceil = (/** @type {bigint} */ a, /** @type {bigint} */ b) => {
  if (b === 0n) {
    throw new Error("Division by zero");
  }
  return (a + b - 1n) / b;
};

export const min = (/** @type {bigint} */ a, /** @type {bigint} */ b) =>
  a < b ? a : b;
export const max = (/** @type {bigint} */ a, /** @type {bigint} */ b) =>
  a > b ? a : b;
export const abs = (/** @type {bigint} */ a) => (a < 0n ? -a : a);

export const isqrt = (/** @type {bigint} */ n) => {
  if (n < 0n) {
    throw new Error("Square root of negative");
  }
  if (n === 0n) {
    return 0n;
  }
  let x0 = n;
  let x1 = n / 2n + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
};

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

  price_spot() {
    if (this.reserve_native === 0n) {
      return 0n;
    }
    return mul_div(this.reserve_foreign, PRECISION, this.reserve_native);
  }

  has_liquidity() {
    return this.reserve_native > 0n && this.reserve_foreign > 0n;
  }

  add_liquidity(
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_amount,
  ) {
    if (native_amount <= 0n || foreign_amount <= 0n) {
      throw new Error("Amounts must be positive");
    }
    if (!this.has_liquidity()) {
      const lp_minted = isqrt(native_amount * foreign_amount);
      if (lp_minted === 0n) {
        throw new Error("Insufficient initial liquidity");
      }
      this.reserve_native = native_amount;
      this.reserve_foreign = foreign_amount;
      this.supply_lp = lp_minted;
      return {
        lp_minted,
        native_used: native_amount,
        foreign_used: foreign_amount,
        native_rest: 0n,
        foreign_rest: 0n,
      };
    }
    const lp_from_native = mul_div(
      native_amount,
      this.supply_lp,
      this.reserve_native,
    );
    const lp_from_foreign = mul_div(
      foreign_amount,
      this.supply_lp,
      this.reserve_foreign,
    );
    const lp_minted = min(lp_from_native, lp_from_foreign);
    if (lp_minted === 0n) {
      throw new Error("Insufficient liquidity provided");
    }
    const native_used = mul_div(this.reserve_native, lp_minted, this.supply_lp);
    const foreign_used = mul_div(
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
      native_rest: native_amount - native_used,
      foreign_rest: foreign_amount - foreign_used,
    };
  }

  get_out_native(/** @type {bigint} */ foreign_amount) {
    if (foreign_amount <= 0n || !this.has_liquidity()) {
      return 0n;
    }
    return this.#calculate_output(
      foreign_amount,
      this.reserve_native,
      this.reserve_foreign,
    );
  }

  get_out_foreign(/** @type {bigint} */ native_amount) {
    if (native_amount <= 0n || !this.has_liquidity()) {
      return 0n;
    }
    return this.#calculate_output(
      native_amount,
      this.reserve_foreign,
      this.reserve_native,
    );
  }

  swap_native_to_foreign(
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_min = 0n,
  ) {
    if (native_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (!this.has_liquidity()) {
      throw new Error("No liquidity");
    }
    const foreign_out = this.get_out_foreign(native_amount);
    if (foreign_out < foreign_min) {
      throw new Error("Slippage exceeded");
    }
    return this.#execute_swap(native_amount, foreign_out, true);
  }

  swap_foreign_to_native(
    /** @type {bigint} */ foreign_amount,
    /** @type {bigint} */ native_min = 0n,
  ) {
    if (foreign_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (!this.has_liquidity()) {
      throw new Error("No liquidity");
    }
    const native_out = this.get_out_native(foreign_amount);
    if (native_out < native_min) {
      throw new Error("Slippage exceeded");
    }
    return this.#execute_swap(foreign_amount, native_out, false);
  }

  #calculate_output(
    /** @type {bigint} */ amount_in,
    /** @type {bigint} */ reserve_out,
    /** @type {bigint} */ reserve_in,
  ) {
    const factor_fee = PPM - this.fee_ppm;
    const amount_with_fee = amount_in * factor_fee;
    const numerator = amount_with_fee * reserve_out;
    const denominator = reserve_in * PPM + amount_with_fee;
    return denominator > 0n ? numerator / denominator : 0n;
  }

  #execute_swap(
    /** @type {bigint} */ amount_in,
    /** @type {bigint} */ amount_out,
    /** @type {boolean} */ native_to_foreign,
  ) {
    const price_before = this.price_spot();
    if (native_to_foreign) {
      this.reserve_native += amount_in;
      this.reserve_foreign -= amount_out;
    } else {
      this.reserve_foreign += amount_in;
      this.reserve_native -= amount_out;
    }
    const price_after = this.price_spot();
    const impact_ppm =
      price_before > 0n
        ? mul_div(abs(price_after - price_before), PPM, price_before)
        : 0n;
    return {
      amount_in,
      amount_out,
      price_before,
      price_after,
      impact_ppm,
    };
  }
}

export class AllInZap {
  execute(
    /** @type {XykPool} */ xyk_pool,
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_amount,
  ) {
    let result = {
      lp_minted: 0n,
      native_used: 0n,
      foreign_used: 0n,
      native_rest: native_amount,
      foreign_rest: foreign_amount,
    };
    if (native_amount === 0n && foreign_amount === 0n) {
      return result;
    }
    if (!xyk_pool.has_liquidity()) {
      if (native_amount > 0n && foreign_amount > 0n) {
        try {
          return xyk_pool.add_liquidity(native_amount, foreign_amount);
        } catch {
          return result;
        }
      }
      return result;
    }
    if (native_amount > 0n && foreign_amount > 0n) {
      const pool_ratio = mul_div(
        xyk_pool.reserve_foreign,
        PRECISION,
        xyk_pool.reserve_native,
      );
      const foreign_by_native = mul_div(native_amount, pool_ratio, PRECISION);
      const [native_to_add, foreign_to_add] =
        foreign_by_native <= foreign_amount
          ? [native_amount, foreign_by_native]
          : [mul_div(foreign_amount, PRECISION, pool_ratio), foreign_amount];
      if (native_to_add > 0n && foreign_to_add > 0n) {
        try {
          const add_result = xyk_pool.add_liquidity(
            native_to_add,
            foreign_to_add,
          );
          result = {
            lp_minted: add_result.lp_minted,
            native_used: add_result.native_used,
            foreign_used: add_result.foreign_used,
            native_rest: native_amount - add_result.native_used,
            foreign_rest: foreign_amount - add_result.foreign_used,
          };
        } catch {
          // Continue to swap phase
        }
      }
    }
    if (result.foreign_rest > 0n) {
      try {
        const swap_result = xyk_pool.swap_foreign_to_native(
          result.foreign_rest,
        );
        result.native_rest += swap_result.amount_out;
        result.foreign_used += result.foreign_rest;
        result.foreign_rest = 0n;
      } catch {
        // Swap failed, keep foreign in buffer
      }
    }
    return result;
  }
}

export class PolManager {
  constructor(
    /** @type {XykPool} */ xyk_pool,
    /** @type {PolZapStrategy} */ strategy,
  ) {
    this.xyk_pool = xyk_pool;
    this.strategy = strategy;
    this.balance_lp = 0n;
    this.contributed_native = 0n;
    this.contributed_foreign = 0n;
    this.buffer_native = 0n;
    this.buffer_foreign = 0n;
  }

  add_liquidity(
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_amount,
  ) {
    const total_native = this.buffer_native + native_amount;
    const total_foreign = this.buffer_foreign + foreign_amount;
    if (total_native === 0n && total_foreign === 0n) {
      return {
        lp_minted: 0n,
        native_used: 0n,
        foreign_used: 0n,
        buffered_native: this.buffer_native,
        buffered_foreign: this.buffer_foreign,
      };
    }
    const zap_result = this.strategy.execute(
      this.xyk_pool,
      total_native,
      total_foreign,
    );
    this.balance_lp += zap_result.lp_minted;
    this.contributed_native += zap_result.native_used;
    this.contributed_foreign += zap_result.foreign_used;
    this.buffer_native = zap_result.native_rest;
    this.buffer_foreign = zap_result.foreign_rest;
    return {
      lp_minted: zap_result.lp_minted,
      native_used: zap_result.native_used,
      foreign_used: zap_result.foreign_used,
      buffered_native: this.buffer_native,
      buffered_foreign: this.buffer_foreign,
    };
  }
}

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

  price_spot() {
    return this.price_initial + mul_div(this.slope_ppm, this.supply, PPM);
  }

  calculate_mint(/** @type {bigint} */ foreign_amount) {
    if (foreign_amount <= 0n) {
      return 0n;
    }
    const price_initial = this.price_initial;
    const slope = this.slope_ppm;
    const supply = this.supply;
    if (slope === 0n) {
      return mul_div(foreign_amount, PRECISION, price_initial);
    }
    const a = slope;
    const b = 2n * (price_initial * PPM + slope * supply);
    const c = -2n * PPM * foreign_amount;
    const discriminant = b * b - 4n * a * c;
    if (discriminant < 0n) {
      return 0n;
    }
    const sqrt_discriminant = isqrt(discriminant);
    const numerator = sqrt_discriminant - b;
    if (numerator <= 0n) {
      return 0n;
    }
    return numerator / (2n * a);
  }

  mint(/** @type {bigint} */ foreign_amount) {
    const price_before = this.price_spot();
    const minted = this.calculate_mint(foreign_amount);
    if (minted === 0n) {
      throw new Error("Insufficient amount");
    }
    this.supply += minted;
    const distribution = this.#distribute(minted);
    this.treasury += distribution.treasury;
    this.team += distribution.team;
    const pol_result = this.pol_manager.add_liquidity(
      distribution.pol,
      foreign_amount,
    );
    const price_after = this.price_spot();
    return {
      minted,
      user_native: distribution.user,
      pol_native: distribution.pol,
      treasury_native: distribution.treasury,
      team_native: distribution.team,
      foreign_amount,
      price_before,
      price_after,
      pol: pol_result,
    };
  }

  preview(/** @type {bigint} */ foreign_amount) {
    const minted = this.calculate_mint(foreign_amount);
    if (minted === 0n) {
      return null;
    }
    return {
      minted,
      ...this.#distribute(minted),
    };
  }

  #distribute(/** @type {bigint} */ minted_amount) {
    const user = mul_div(minted_amount, this.shares.user_ppm, PPM);
    const pol = mul_div(minted_amount, this.shares.pol_ppm, PPM);
    const treasury = mul_div(minted_amount, this.shares.treasury_ppm, PPM);
    const team = minted_amount - (user + pol + treasury);
    return { user, pol, treasury, team };
  }
}

export class SmartRouter {
  constructor(
    /** @type {XykPool} */ xyk_pool,
    /** @type {UtbcMinter} */ utbc_minter,
    /** @type {SmartRouterConfig} */ config,
  ) {
    this.xyk_pool = xyk_pool;
    this.utbc_minter = utbc_minter;
    this.fee_ppm = config.fee_router_ppm;
    this.accumulated_fee = 0n;
  }

  quote_best_route(/** @type {bigint} */ foreign_amount) {
    if (foreign_amount <= 0n) {
      return null;
    }
    const { fee, net } = this.#preview_fee(foreign_amount);
    const utbc_quote = this.utbc_minter.preview(net);
    const utbc_out = utbc_quote?.user ?? 0n;
    const xyk_out = this.xyk_pool.get_out_native(net);
    const utbc_viable = utbc_quote && utbc_out > 0n;
    const xyk_viable = xyk_out > 0n;
    if (!utbc_viable && !xyk_viable) {
      return { best: "NONE", out: 0n, foreign_amount, net, fee };
    }
    const use_utbc = utbc_viable && utbc_out >= xyk_out;
    return {
      best: use_utbc ? "UTBC" : "XYK",
      out: use_utbc ? utbc_out : xyk_out,
      foreign_amount,
      net,
      fee,
    };
  }

  swap_foreign_to_native(
    /** @type {bigint} */ foreign_amount,
    /** @type {bigint} */ native_min = 0n,
  ) {
    if (foreign_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const { net } = this.#preview_fee(foreign_amount);
    if (net <= 0n) {
      throw new Error("Amount too small");
    }
    const utbc_quote = this.utbc_minter.preview(net);
    const utbc_out = utbc_quote?.user ?? 0n;
    const xyk_out = this.xyk_pool.get_out_native(net);
    const can_utbc = utbc_quote && utbc_out >= native_min;
    const can_xyk = xyk_out >= native_min;
    if (!can_utbc && !can_xyk) {
      throw new Error("Slippage exceeded");
    }
    const { fee, net: net_after_fee } = this.#apply_fee(foreign_amount);
    const use_utbc = can_utbc && utbc_out >= xyk_out;
    if (use_utbc) {
      const mint_result = this.utbc_minter.mint(net_after_fee);
      return {
        route: "UTBC",
        out: mint_result.user_native,
        foreign_amount,
        net: net_after_fee,
        fee,
        price_before: mint_result.price_before,
        price_after: mint_result.price_after,
        pol: mint_result.pol,
      };
    } else {
      const swap = this.xyk_pool.swap_foreign_to_native(
        net_after_fee,
        native_min,
      );
      return {
        route: "XYK",
        out: swap.amount_out,
        foreign_amount,
        net: net_after_fee,
        fee,
        price_before: swap.price_before,
        price_after: swap.price_after,
        impact_ppm: swap.impact_ppm,
      };
    }
  }

  swap_native_to_foreign(
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_min = 0n,
  ) {
    if (native_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const pre_fee_out = this.xyk_pool.get_out_foreign(native_amount);
    if (pre_fee_out === 0n) {
      throw new Error("No liquidity");
    }
    const fee_factor = PPM - this.fee_ppm;
    const out_pre_fee_min =
      foreign_min > 0n ? div_ceil(foreign_min * PPM, fee_factor) : 0n;
    if (pre_fee_out < out_pre_fee_min) {
      const actual_out = mul_div(pre_fee_out, fee_factor, PPM);
      throw new Error(`Slippage: ${actual_out} < ${foreign_min}`);
    }
    const swap_result = this.xyk_pool.swap_native_to_foreign(
      native_amount,
      out_pre_fee_min,
    );
    const { fee, net } = this.#apply_fee(swap_result.amount_out);
    return {
      route: "XYK",
      out: net,
      native_amount,
      fee,
      price_before: swap_result.price_before,
      price_after: swap_result.price_after,
      impact_ppm: swap_result.impact_ppm,
    };
  }

  #apply_fee(/** @type {bigint} */ amount_gross) {
    const fee = mul_div(amount_gross, this.fee_ppm, PPM);
    this.accumulated_fee += fee;
    return { fee, net: amount_gross - fee };
  }

  #preview_fee(/** @type {bigint} */ amount_gross) {
    const fee = mul_div(amount_gross, this.fee_ppm, PPM);
    return { fee, net: amount_gross - fee };
  }
}

export const create_system = (
  /** @type {Partial<SystemConfig>} */ user_config,
) => {
  const config = { ...DEFAULT_CONFIG, ...user_config };
  const xyk_pool = new XykPool({ fee_ppm: config.fee_xyk_ppm });
  const pol_manager = new PolManager(xyk_pool, new AllInZap());
  const utbc_minter = new UtbcMinter(pol_manager, {
    price_initial: config.price_initial,
    slope_ppm: config.slope_ppm,
    shares: config.shares,
  });
  const router = new SmartRouter(xyk_pool, utbc_minter, {
    fee_router_ppm: config.fee_router_ppm,
  });
  return { xyk_pool, pol_manager, utbc_minter, router };
};
