/**
 * UTBC+POL Simulator
 * @module simulator.js
 */

export const DECIMALS = 12n;
export const PRECISION = 10n ** DECIMALS;
export const PPM = 1_000_000n;

const DEFAULT_CONFIG = /** @type {SystemConfig} */ ({
  initial_price: 1_000_000_000n,
  slope_ppm: 1_000n,
  xyk_fee_ppm: 3_000n,
  router_fee_ppm: 2_000n,
  shares: {
    user_ppm: 333_333n,
    pol_ppm: 333_333n,
    treasury_ppm: 222_222n,
    team_ppm: 111_112n,
  },
});

/** @typedef {{ user_ppm: bigint, pol_ppm: bigint, treasury_ppm: bigint, team_ppm: bigint }} ShareConfig */
/** @typedef {{ lp_minted: bigint, used_native: bigint, used_foreign: bigint, unused_native: bigint, unused_foreign: bigint }} LiquidityResult */
/** @typedef {{ fee_ppm: bigint }} XykPoolConfig */
/** @typedef {{ lp_minted: bigint, used_native: bigint, used_foreign: bigint, remaining_native: bigint, remaining_foreign: bigint }} ZapResult */
/** @typedef {(XykPool: XykPool, native_amount: bigint, foreign_amount: bigint) => ZapResult} ZapExecute */
/** @typedef {{ execute: ZapExecute }} PolZapStrategy */
/** @typedef {{ initial_price: bigint, slope_ppm: bigint, shares: ShareConfig }} UtbcMinterConfig */
/** @typedef {{ router_fee_ppm: bigint }} SmartRouterConfig */
/** @typedef {{ initial_price: bigint, slope_ppm: bigint, xyk_fee_ppm: bigint, router_fee_ppm: bigint, shares: ShareConfig }} SystemConfig */

export const mul_div = (
  /** @type {bigint} */ a,
  /** @type {bigint} */ b,
  /** @type {bigint} */ c,
) => {
  if (c === 0n) {
    throw new Error("Division by zero");
  }
  if (b === c) {
    return a;
  }
  return (a * b) / c;
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
    this.foreign_reserve = 0n;
    this.native_reserve = 0n;
    this.lp_total_supply = 0n;
  }

  get_spot_price() {
    if (this.native_reserve === 0n) {
      return 0n;
    }
    return mul_div(this.foreign_reserve, PRECISION, this.native_reserve);
  }

  has_liquidity() {
    return this.foreign_reserve > 0n && this.native_reserve > 0n;
  }

  add_liquidity(
    /** @type {bigint} */ foreign_amount,
    /** @type {bigint} */ native_amount,
  ) {
    if (foreign_amount <= 0n || native_amount <= 0n) {
      throw new Error("Amounts must be positive");
    }
    if (this.foreign_reserve === 0n || this.native_reserve === 0n) {
      const lp_minted = isqrt(foreign_amount * native_amount);
      if (lp_minted === 0n) {
        throw new Error("Insufficient initial liquidity");
      }
      this.foreign_reserve = foreign_amount;
      this.native_reserve = native_amount;
      this.lp_total_supply = lp_minted;
      return {
        lp_minted,
        used_foreign: foreign_amount,
        used_native: native_amount,
        unused_foreign: 0n,
        unused_native: 0n,
      };
    }
    const lp_from_foreign = mul_div(
      foreign_amount,
      this.lp_total_supply,
      this.foreign_reserve,
    );
    const lp_from_native = mul_div(
      native_amount,
      this.lp_total_supply,
      this.native_reserve,
    );
    const lp_minted = min(lp_from_foreign, lp_from_native);
    if (lp_minted === 0n) {
      throw new Error("Insufficient liquidity provided");
    }
    const used_foreign = mul_div(
      this.foreign_reserve,
      lp_minted,
      this.lp_total_supply,
    );
    const used_native = mul_div(
      this.native_reserve,
      lp_minted,
      this.lp_total_supply,
    );
    this.foreign_reserve += used_foreign;
    this.native_reserve += used_native;
    this.lp_total_supply += lp_minted;
    return {
      lp_minted,
      used_foreign,
      used_native,
      unused_foreign: foreign_amount - used_foreign,
      unused_native: native_amount - used_native,
    };
  }

  get_native_out_for_foreign_in(/** @type {bigint} */ foreign_in) {
    if (foreign_in <= 0n || !this.has_liquidity()) {
      return 0n;
    }
    return this.#calculate_output(
      foreign_in,
      this.native_reserve,
      this.foreign_reserve,
    );
  }

  get_foreign_out_for_native_in(/** @type {bigint} */ native_in) {
    if (native_in <= 0n || !this.has_liquidity()) {
      return 0n;
    }
    return this.#calculate_output(
      native_in,
      this.foreign_reserve,
      this.native_reserve,
    );
  }

  #calculate_output(
    /** @type {bigint} */ input,
    /** @type {bigint} */ output_reserve,
    /** @type {bigint} */ input_reserve,
  ) {
    const fee_factor = PPM - this.fee_ppm;
    const input_with_fee = input * fee_factor;
    const num = input_with_fee * output_reserve;
    const den = input_reserve * PPM + input_with_fee;
    return den > 0n ? num / den : 0n;
  }

  swap_exact_foreign_for_native(
    /** @type {bigint} */ foreign_in,
    /** @type {bigint} */ min_native_out = 0n,
  ) {
    if (foreign_in <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (!this.has_liquidity()) {
      throw new Error("No liquidity");
    }
    const native_out = this.get_native_out_for_foreign_in(foreign_in);
    if (native_out < min_native_out) {
      throw new Error(`Slippage: ${native_out} < ${min_native_out}`);
    }
    return this.#execute_foreign_for_native_swap(foreign_in, native_out);
  }

  swap_exact_native_for_foreign(
    /** @type {bigint} */ native_in,
    /** @type {bigint} */ min_foreign_out = 0n,
  ) {
    if (native_in <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (!this.has_liquidity()) {
      throw new Error("No liquidity");
    }
    const foreign_out = this.get_foreign_out_for_native_in(native_in);
    if (foreign_out < min_foreign_out) {
      throw new Error(`Slippage: ${foreign_out} < ${min_foreign_out}`);
    }
    return this.#execute_native_for_foreign_swap(native_in, foreign_out);
  }

  #execute_foreign_for_native_swap(
    /** @type {bigint} */ foreign_in,
    /** @type {bigint} */ native_out,
  ) {
    const price_before = this.get_spot_price();
    this.foreign_reserve += foreign_in;
    this.native_reserve -= native_out;
    const price_after = this.get_spot_price();
    return {
      foreign_in,
      native_out,
      price_before,
      price_after,
      price_impact: this.#calculate_price_impact(price_before, price_after),
    };
  }

  #execute_native_for_foreign_swap(
    /** @type {bigint} */ native_in,
    /** @type {bigint} */ foreign_out,
  ) {
    const price_before = this.get_spot_price();
    this.native_reserve += native_in;
    this.foreign_reserve -= foreign_out;
    const price_after = this.get_spot_price();
    return {
      native_in,
      foreign_out,
      price_before,
      price_after,
      price_impact: this.#calculate_price_impact(price_before, price_after),
    };
  }

  #calculate_price_impact(
    /** @type {bigint} */ price_before,
    /** @type {bigint} */ price_after,
  ) {
    return price_before > 0n
      ? mul_div(abs(price_after - price_before), PRECISION, price_before)
      : 0n;
  }
}

/**
 * AllInZap Strategy: Two-phase approach for maximum LP + native accumulation
 * Step 1: Add liquidity proportionally to pool using available assets
 * Step 2: Swap ALL remaining foreign (change) to native for POL buffer
 * Goal: Maximize LP while ensuring all foreign is converted to native for next mint cycle
 */
export class AllInZap {
  execute(
    /** @type {XykPool} */ xyk_pool,
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_amount,
  ) {
    let total_used_native = 0n;
    let total_used_foreign = 0n;
    let stage1_lp = 0n;
    let rem_native = native_amount;
    let rem_foreign = foreign_amount;
    if (rem_native === 0n && rem_foreign === 0n) {
      return this.#result(0n, 0n, 0n, 0n, 0n);
    }
    if (!xyk_pool.has_liquidity()) {
      if (rem_native > 0n && rem_foreign > 0n) {
        try {
          const add = xyk_pool.add_liquidity(rem_foreign, rem_native);
          return this.#result(
            add.lp_minted,
            add.used_native,
            add.used_foreign,
            add.unused_native,
            add.unused_foreign,
          );
        } catch {
          // Initial liquidity failed, keep assets in buffer
        }
      }
      return this.#result(0n, 0n, 0n, rem_native, rem_foreign);
    }
    if (rem_native > 0n && rem_foreign > 0n) {
      const pool_ratio = mul_div(
        xyk_pool.foreign_reserve,
        PRECISION,
        xyk_pool.native_reserve,
      );
      // Determine limiting asset based on pool ratio
      const foreign_by_native = mul_div(rem_native, pool_ratio, PRECISION);
      let try_foreign, try_native;
      if (foreign_by_native <= rem_foreign) {
        // Native is limiting - use all native
        try_foreign = foreign_by_native;
        try_native = rem_native;
      } else {
        // Foreign is limiting - use all foreign
        try_foreign = rem_foreign;
        try_native = mul_div(rem_foreign, PRECISION, pool_ratio);
      }
      if (try_foreign > 0n && try_native > 0n) {
        try {
          const r = xyk_pool.add_liquidity(try_foreign, try_native);
          stage1_lp = r.lp_minted;
          total_used_native = r.used_native;
          total_used_foreign = r.used_foreign;
          rem_native = native_amount - r.used_native;
          rem_foreign = foreign_amount - r.used_foreign;
        } catch {
          // Add liquidity failed, proceed to swap
        }
      }
    }
    if (rem_foreign > 0n) {
      try {
        const swap = xyk_pool.swap_exact_foreign_for_native(rem_foreign);
        rem_native += swap.native_out;
        total_used_foreign += rem_foreign;
        rem_foreign = 0n;
      } catch {
        // Swap failed, foreign remains in buffer
      }
    }
    return this.#result(
      stage1_lp,
      total_used_native,
      total_used_foreign,
      rem_native,
      rem_foreign,
    );
  }

  #result(
    /** @type {bigint} */ lp_minted,
    /** @type {bigint} */ used_native,
    /** @type {bigint} */ used_foreign,
    /** @type {bigint} */ remaining_native,
    /** @type {bigint} */ remaining_foreign,
  ) {
    return {
      lp_minted,
      used_native,
      used_foreign,
      remaining_native,
      remaining_foreign,
    };
  }
}

export class PolManager {
  constructor(
    /** @type {XykPool} */ xyk_pool,
    /** @type {PolZapStrategy} */ zap_strategy,
  ) {
    this.xyk_pool = xyk_pool;
    this.zap_strategy = zap_strategy;
    this.lp_balance = 0n;
    this.total_native_contributed = 0n;
    this.total_foreign_contributed = 0n;
    this.native_buffer = 0n;
    this.foreign_buffer = 0n;
  }

  add_pol_liquidity(
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ foreign_amount,
  ) {
    const total_native = this.native_buffer + native_amount;
    const total_foreign = this.foreign_buffer + foreign_amount;
    if (total_native === 0n && total_foreign === 0n) {
      return {
        lp_minted: 0n,
        stage1_lp: 0n,
        stage2_lp: 0n,
        buffered_native: this.native_buffer,
        buffered_foreign: this.foreign_buffer,
      };
    }
    const zap = this.zap_strategy.execute(
      this.xyk_pool,
      total_native,
      total_foreign,
    );
    this.lp_balance += zap.lp_minted;
    this.total_native_contributed += zap.used_native;
    this.total_foreign_contributed += zap.used_foreign;
    this.native_buffer = zap.remaining_native;
    this.foreign_buffer = zap.remaining_foreign;
    return {
      lp_minted: zap.lp_minted,
      buffered_native: this.native_buffer,
      buffered_foreign: this.foreign_buffer,
    };
  }
}

export class UtbcMinter {
  constructor(
    /** @type {PolManager} */ pol_manager,
    /** @type {UtbcMinterConfig} */ config,
  ) {
    if (config.initial_price <= 0n) {
      throw new Error("Initial price must be positive");
    }
    if (config.slope_ppm < 0n) {
      throw new Error("Slope must be non-negative");
    }
    this.initial_price = config.initial_price;
    this.slope_ppm = config.slope_ppm;
    this.shares = config.shares;
    this.pol_manager = pol_manager;
    this.#validate_shares();
    this.total_supply = 0n;
    this.treasury_balance = 0n;
    this.team_balance = 0n;
  }

  #validate_shares() {
    const sum = Object.values(this.shares).reduce((a, b) => a + b, 0n);
    if (sum !== PPM) {
      throw new Error(`Shares must sum to ${PPM}, got ${sum}`);
    }
  }

  get_spot_price() {
    return this.initial_price + mul_div(this.slope_ppm, this.total_supply, PPM);
  }

  calculate_mint_amount(/** @type {bigint} */ foreign_amount) {
    if (foreign_amount <= 0n) {
      return 0n;
    }
    const p0 = this.initial_price;
    const k = this.slope_ppm;
    const s0 = this.total_supply;
    if (k === 0n) {
      return mul_div(foreign_amount, PRECISION, p0);
    }
    const a = k;
    const b = 2n * (p0 * PPM + k * s0);
    const c = -2n * PPM * PRECISION * foreign_amount;
    const disc = b * b - 4n * a * c;
    if (disc < 0n) {
      return 0n;
    }
    const sqrt_disc = isqrt(disc);
    const num = sqrt_disc - b;
    if (num <= 0n) {
      return 0n;
    }
    return num / (2n * a);
  }

  mint_from_foreign(/** @type {bigint} */ foreign_amount) {
    const price_before = this.get_spot_price();
    const minted = this.calculate_mint_amount(foreign_amount);
    if (minted === 0n) {
      throw new Error("Insufficient foreign amount");
    }
    this.total_supply += minted;
    const distribution = this.#calculate_distribution(minted);
    this.treasury_balance += distribution.treasury;
    this.team_balance += distribution.team;
    const pol_result = this.pol_manager.add_pol_liquidity(
      distribution.pol,
      foreign_amount,
    );
    const price_after = this.get_spot_price();
    return {
      total_minted: minted,
      user_native: distribution.user,
      pol_native: distribution.pol,
      treasury_native: distribution.treasury,
      team_native: distribution.team,
      foreign_spent: foreign_amount,
      price_before,
      price_after,
      pol_result,
    };
  }

  #calculate_distribution(/** @type {bigint} */ minted) {
    const user = mul_div(minted, this.shares.user_ppm, PPM);
    const pol = mul_div(minted, this.shares.pol_ppm, PPM);
    const treasury = mul_div(minted, this.shares.treasury_ppm, PPM);
    const team = minted - (user + pol + treasury);
    return { user, pol, treasury, team };
  }

  preview_mint(/** @type {bigint} */ foreign_amount) {
    const minted = this.calculate_mint_amount(foreign_amount);
    if (minted === 0n) {
      return null;
    }
    const distribution = this.#calculate_distribution(minted);
    return {
      total_minted: minted,
      user_native: distribution.user,
      pol_native: distribution.pol,
      treasury_native: distribution.treasury,
      team_native: distribution.team,
    };
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
    this.router_fee_ppm = config.router_fee_ppm;
    this.router_fee_accumulated = 0n;
  }

  #take_router_fee(/** @type {bigint} */ amount) {
    const fee = mul_div(amount, this.router_fee_ppm, PPM);
    this.router_fee_accumulated += fee;
    return { fee, net: amount - fee };
  }

  #peek_router_fee(/** @type {bigint} */ amount) {
    const fee = mul_div(amount, this.router_fee_ppm, PPM);
    return { fee, net: amount - fee };
  }

  quote_best_route_for_buy(/** @type {bigint} */ foreign_amount) {
    if (foreign_amount <= 0n) {
      return null;
    }
    const { fee, net } = this.#peek_router_fee(foreign_amount);
    const utbc_quote = this.utbc_minter.preview_mint(net);
    const utbc_native = utbc_quote?.user_native ?? 0n;
    const xyk_native = this.xyk_pool.get_native_out_for_foreign_in(net);
    const utbc_viable = utbc_quote && utbc_native > 0n;
    const xyk_viable = xyk_native > 0n;
    if (!utbc_viable && !xyk_viable) {
      return {
        best_route: "NONE",
        native_out: 0n,
        foreign_in: foreign_amount,
        foreign_in_after_fee: net,
        router_fee: fee,
      };
    }
    const is_utbc = utbc_viable && utbc_native >= xyk_native;
    return {
      best_route: is_utbc ? "UTBC" : "XYK",
      native_out: is_utbc ? utbc_native : xyk_native,
      foreign_in: foreign_amount,
      foreign_in_after_fee: net,
      router_fee: fee,
    };
  }

  route_swap_exact_foreign_for_native(
    /** @type {bigint} */ foreign_amount,
    /** @type {bigint} */ min_native_out = 0n,
  ) {
    if (foreign_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const { net: foreign_net_preview } = this.#peek_router_fee(foreign_amount);
    if (foreign_net_preview <= 0n) {
      throw new Error("Amount too small after router fee");
    }
    const utbc_quote = this.utbc_minter.preview_mint(foreign_net_preview);
    const utbc_user = utbc_quote?.user_native ?? 0n;
    const xyk_user =
      this.xyk_pool.get_native_out_for_foreign_in(foreign_net_preview);
    const can_utbc = utbc_quote && utbc_user >= min_native_out;
    const can_xyk = xyk_user >= min_native_out;
    if (!can_utbc && !can_xyk) {
      throw new Error(`Slippage: 0 < ${min_native_out}`);
    }
    const choose_utbc = can_utbc && (!can_xyk || utbc_user >= xyk_user);
    const { fee, net } = this.#take_router_fee(foreign_amount);
    if (choose_utbc) {
      const mint = this.utbc_minter.mint_from_foreign(net);
      return {
        route: "UTBC",
        native_out: mint.user_native,
        foreign_in: foreign_amount,
        foreign_in_after_fee: net,
        router_fee_taken: fee,
        price_before: mint.price_before,
        price_after: mint.price_after,
        pol_result: mint.pol_result,
      };
    } else {
      const swap = this.xyk_pool.swap_exact_foreign_for_native(
        net,
        min_native_out,
      );
      return {
        route: "XYK",
        native_out: swap.native_out,
        foreign_in: foreign_amount,
        foreign_in_after_fee: net,
        router_fee_taken: fee,
        price_before: swap.price_before,
        price_after: swap.price_after,
        price_impact: swap.price_impact,
      };
    }
  }

  route_swap_exact_native_for_foreign(
    /** @type {bigint} */ native_amount,
    /** @type {bigint} */ min_foreign_out = 0n,
  ) {
    if (native_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const pre_fee_out =
      this.xyk_pool.get_foreign_out_for_native_in(native_amount);
    if (pre_fee_out === 0n) {
      throw new Error("No liquidity");
    }
    // Minimum pre-fee output so that post-fee >= user min
    const fee_denom = PPM - this.router_fee_ppm;
    const min_pre_fee_out =
      min_foreign_out > 0n ? div_ceil(min_foreign_out * PPM, fee_denom) : 0n;
    if (pre_fee_out < min_pre_fee_out) {
      const post_fee_preview = mul_div(pre_fee_out, fee_denom, PPM);
      throw new Error(`Slippage: ${post_fee_preview} < ${min_foreign_out}`);
    }
    const swap = this.xyk_pool.swap_exact_native_for_foreign(
      native_amount,
      min_pre_fee_out,
    );
    const { fee, net } = this.#take_router_fee(swap.foreign_out);
    return {
      route: "XYK",
      foreign_out: net,
      native_in: native_amount,
      router_fee_taken: fee,
      price_before: swap.price_before,
      price_after: swap.price_after,
      price_impact: swap.price_impact,
    };
  }
}

export const create_system = (/** @type {SystemConfig} */ user_config) => {
  const config = { ...DEFAULT_CONFIG, ...user_config };
  const xyk_pool = new XykPool({
    fee_ppm: config.xyk_fee_ppm,
  });
  const pol_manager = new PolManager(xyk_pool, new AllInZap());
  const utbc_minter = new UtbcMinter(pol_manager, {
    initial_price: config.initial_price,
    slope_ppm: config.slope_ppm,
    shares: config.shares,
  });
  const router = new SmartRouter(xyk_pool, utbc_minter, {
    router_fee_ppm: config.router_fee_ppm,
  });
  return { xyk_pool, pol_manager, utbc_minter, router };
};
