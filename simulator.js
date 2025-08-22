/**
 * UTBC+POL Simulator
 * @module simulator
 */

const DECIMALS = 12n;
const PRECISION = 10n ** DECIMALS;
const PERMILL = 1_000_000n;
const MIN_LIQUIDITY = 1_000n;

const mul_div = (a, b, c, round_up = false) => {
  if (c === 0n) {
    throw new Error("Division by zero");
  }
  const result = (a * b) / c;
  if (!round_up) return result;
  const remainder = (a * b) % c;
  return remainder > 0n ? result + 1n : result;
};

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);

const sqrt = (value) => {
  if (value < 0n) {
    throw new Error("Square root of negative number");
  }
  if (value === 0n) {
    return 0n;
  }
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
};

class XykPool {
  constructor(fee = 3_000n) {
    if (fee >= PERMILL) {
      throw new Error("Fee must be < 100%");
    }
    this.fee = fee;
    this.native_reserve = 0n;
    this.foreign_reserve = 0n;
    this.lp_total_supply = 0n;
  }

  add_liquidity(foreign_amount, native_amount) {
    if (foreign_amount <= 0n || native_amount <= 0n) {
      throw new Error("Amounts must be positive");
    }
    const snapshot = {
      foreign: this.foreign_reserve,
      native: this.native_reserve,
      lp_supply: this.lp_total_supply,
    };
    // Handle initial liquidity provision
    if (this.foreign_reserve === 0n || this.native_reserve === 0n) {
      return this.#add_initial_liquidity(
        foreign_amount,
        native_amount,
        snapshot,
      );
    }
    // Handle subsequent liquidity with ratio maintenance
    return this.#add_proportional_liquidity(
      foreign_amount,
      native_amount,
      snapshot,
    );
  }

  #add_initial_liquidity(foreign_amount, native_amount, snapshot) {
    const lp_geometric_mean = sqrt(foreign_amount * native_amount);
    if (lp_geometric_mean <= MIN_LIQUIDITY) {
      throw new Error("Insufficient initial liquidity");
    }
    const lp_minted = lp_geometric_mean - MIN_LIQUIDITY;
    this.foreign_reserve = foreign_amount;
    this.native_reserve = native_amount;
    this.lp_total_supply = lp_geometric_mean;
    return {
      lp_minted,
      used_foreign: foreign_amount,
      used_native: native_amount,
      unused_foreign: 0n,
      unused_native: 0n,
      reserves_before: snapshot,
      reserves_after: {
        foreign: this.foreign_reserve,
        native: this.native_reserve,
        lp_supply: this.lp_total_supply,
      },
    };
  }

  #add_proportional_liquidity(foreign_amount, native_amount, snapshot) {
    const foreign_lp_ratio = mul_div(
      foreign_amount,
      this.lp_total_supply,
      this.foreign_reserve,
    );
    const native_lp_ratio = mul_div(
      native_amount,
      this.lp_total_supply,
      this.native_reserve,
    );
    const lp_minted = min(foreign_lp_ratio, native_lp_ratio);
    if (lp_minted === 0n) {
      throw new Error("Insufficient liquidity");
    }
    const used_foreign = mul_div(
      this.foreign_reserve,
      lp_minted,
      this.lp_total_supply,
      true,
    );
    const used_native = mul_div(
      this.native_reserve,
      lp_minted,
      this.lp_total_supply,
      true,
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
      reserves_before: snapshot,
      reserves_after: {
        foreign: this.foreign_reserve,
        native: this.native_reserve,
        lp_supply: this.lp_total_supply,
      },
    };
  }

  swap_exact_foreign_for_native(foreign_in) {
    if (foreign_in <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (this.foreign_reserve === 0n || this.native_reserve === 0n) {
      throw new Error("No liquidity");
    }
    const snapshot = {
      foreign: this.foreign_reserve,
      native: this.native_reserve,
      price: this.get_spot_price(),
    };
    const foreign_after_fee = foreign_in * (PERMILL - this.fee);
    const native_out =
      (foreign_after_fee * this.native_reserve) /
      (this.foreign_reserve * PERMILL + foreign_after_fee);
    this.foreign_reserve += foreign_in;
    this.native_reserve -= native_out;
    return {
      native_out,
      foreign_in,
      fee_paid: mul_div(foreign_in, this.fee, PERMILL),
      price_before: snapshot.price,
      price_after: this.get_spot_price(),
      reserves_before: { foreign: snapshot.foreign, native: snapshot.native },
      reserves_after: {
        foreign: this.foreign_reserve,
        native: this.native_reserve,
      },
    };
  }

  swap_exact_native_for_foreign(native_in) {
    if (native_in <= 0n) {
      throw new Error("Amount must be positive");
    }
    if (this.foreign_reserve === 0n || this.native_reserve === 0n) {
      throw new Error("No liquidity");
    }
    const snapshot = {
      foreign: this.foreign_reserve,
      native: this.native_reserve,
      price: this.get_spot_price(),
    };
    const native_after_fee = native_in * (PERMILL - this.fee);
    const foreign_out =
      (native_after_fee * this.foreign_reserve) /
      (this.native_reserve * PERMILL + native_after_fee);
    this.native_reserve += native_in;
    this.foreign_reserve -= foreign_out;
    return {
      foreign_out,
      native_in,
      fee_paid: mul_div(native_in, this.fee, PERMILL),
      price_before: snapshot.price,
      price_after: this.get_spot_price(),
      reserves_before: { foreign: snapshot.foreign, native: snapshot.native },
      reserves_after: {
        foreign: this.foreign_reserve,
        native: this.native_reserve,
      },
    };
  }

  get_foreign_out_for_native_in(native_in) {
    if (
      native_in <= 0n ||
      this.foreign_reserve === 0n ||
      this.native_reserve === 0n
    ) {
      return 0n;
    }
    const native_after_fee = native_in * (PERMILL - this.fee);
    return (
      (native_after_fee * this.foreign_reserve) /
      (this.native_reserve * PERMILL + native_after_fee)
    );
  }

  get_native_out_for_foreign_in(foreign_in) {
    if (
      foreign_in <= 0n ||
      this.foreign_reserve === 0n ||
      this.native_reserve === 0n
    ) {
      return 0n;
    }
    const foreign_after_fee = foreign_in * (PERMILL - this.fee);
    return (
      (foreign_after_fee * this.native_reserve) /
      (this.foreign_reserve * PERMILL + foreign_after_fee)
    );
  }

  get_spot_price() {
    // Returns the price of 1 native token in foreign tokens (scaled by PRECISION)
    return this.native_reserve === 0n
      ? 0n
      : mul_div(this.foreign_reserve, PRECISION, this.native_reserve);
  }
}

class UtbcMinter {
  static DEFAULT_SHARES = {
    user: 333_333n, // 33.3333%
    pol: 333_333n, // 33.3333%
    treasury: 222_222n, // 22.2222%
    team: 111_112n, // 11.1112%
  };

  constructor(initial_price, slope, shares = null) {
    if (initial_price <= 0n) {
      throw new Error("Initial price must be positive");
    }
    if (slope < 0n) {
      throw new Error("Slope must be non-negative");
    }
    this.initial_price = initial_price;
    this.slope = slope;
    this.shares = shares || UtbcMinter.DEFAULT_SHARES;
    this.#validate_shares();
    this.#init_state();
  }

  #validate_shares() {
    const total_shares = Object.values(this.shares).reduce(
      (sum, share) => sum + share,
      0n,
    );
    if (total_shares !== PERMILL) {
      throw new Error(`Shares must sum to ${PERMILL}, got ${total_shares}`);
    }
  }

  #init_state() {
    this.total_supply = 0n;
    this.treasury_balance = 0n;
    this.team_balance = 0n;
    this.total_burned = 0n;
  }

  get_spot_price() {
    return this.initial_price + mul_div(this.slope, this.total_supply, PERMILL);
  }

  calculate_mint_amount(foreign_amount) {
    if (foreign_amount <= 0n) {
      return 0n;
    }
    const { initial_price: p0, slope: k, total_supply: s0 } = this;
    // Constant price case
    if (k === 0n) {
      return mul_div(foreign_amount, PRECISION, p0);
    }
    // Quadratic formula for linear bonding curve: P = P0 + k*S/PERMILL
    const a = k;
    const b = 2n * PERMILL * p0 + 2n * k * s0;
    const c = -2n * PERMILL * PRECISION * foreign_amount;
    const discriminant = b * b - 4n * a * c;
    if (discriminant < 0n) {
      return 0n;
    }
    const minted = (sqrt(discriminant) - b) / (2n * a);
    return minted > 0n ? minted : 0n;
  }

  mint_from_foreign(foreign_amount) {
    const minted = this.calculate_mint_amount(foreign_amount);
    if (minted === 0n) {
      throw new Error("Insufficient foreign amount");
    }
    const snapshot = {
      price: this.get_spot_price(),
      supply: this.total_supply,
    };
    this.total_supply += minted;
    const distribution = this.split_minted(minted);
    this.treasury_balance += distribution.treasury;
    this.team_balance += distribution.team;
    return {
      total_minted: minted,
      user_native: distribution.user,
      pol_native: distribution.pol,
      treasury_native: distribution.treasury,
      team_native: distribution.team,
      foreign_spent: foreign_amount,
      price_before: snapshot.price,
      price_after: this.get_spot_price(),
      supply_before: snapshot.supply,
      supply_after: this.total_supply,
    };
  }

  split_minted(minted_amount) {
    const user = mul_div(minted_amount, this.shares.user, PERMILL);
    const pol = mul_div(minted_amount, this.shares.pol, PERMILL);
    const treasury = mul_div(minted_amount, this.shares.treasury, PERMILL);
    // Team gets remainder to ensure all tokens are distributed
    const team = minted_amount - (user + pol + treasury);
    return { user, pol, treasury, team };
  }

  burn_native(amount) {
    if (amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const burn_amount = amount > this.total_supply ? this.total_supply : amount;
    this.total_supply -= burn_amount;
    this.total_burned += burn_amount;
  }

  preview_mint(foreign_amount) {
    const minted = this.calculate_mint_amount(foreign_amount);
    if (minted === 0n) {
      return null;
    }
    const distribution = this.split_minted(minted);
    return {
      total_minted: minted,
      user_native: distribution.user,
      pol_native: distribution.pol,
      treasury_native: distribution.treasury,
      team_native: distribution.team,
    };
  }
}

class PolManager {
  constructor() {
    this.lp_balance = 0n;
    this.total_native_contributed = 0n;
    this.total_foreign_contributed = 0n;
    this.total_native_unused = 0n;
    this.total_foreign_unused = 0n;
  }

  add_pol_liquidity(native, foreign, pool) {
    if (!pool || native <= 0n || foreign <= 0n) {
      throw new Error("Invalid parameters");
    }
    const liquidity_result = pool.add_liquidity(foreign, native);
    this.lp_balance += liquidity_result.lp_minted;
    this.total_native_contributed += liquidity_result.used_native;
    this.total_foreign_contributed += liquidity_result.used_foreign;
    this.total_native_unused += liquidity_result.unused_native;
    this.total_foreign_unused += liquidity_result.unused_foreign;
    return {
      lp_minted: liquidity_result.lp_minted,
      native_contributed: liquidity_result.used_native,
      foreign_contributed: liquidity_result.used_foreign,
      native_unused: liquidity_result.unused_native,
      foreign_unused: liquidity_result.unused_foreign,
      total_lp_balance: this.lp_balance,
      total_native_contributed: this.total_native_contributed,
      total_foreign_contributed: this.total_foreign_contributed,
      total_native_unused: this.total_native_unused,
      total_foreign_unused: this.total_foreign_unused,
    };
  }

  preview_zap(native, foreign, pool) {
    if (!pool || (native <= 0n && foreign <= 0n)) {
      return null;
    }
    const reserves = {
      foreign: pool.foreign_reserve,
      native: pool.native_reserve,
    };
    // Empty pool: no swap needed
    if (reserves.foreign === 0n || reserves.native === 0n) {
      return this.#create_empty_pool_plan(native, foreign);
    }
    // Calculate optimal swap using closed-form formula
    const fee_params = this.#get_fee_parameters(pool);
    const excess_scaled = foreign * reserves.native - native * reserves.foreign;
    if (excess_scaled > 0n) {
      return this.#plan_foreign_heavy_zap(
        native,
        foreign,
        reserves,
        fee_params,
        excess_scaled,
        pool,
      );
    } else if (excess_scaled < 0n) {
      return this.#plan_native_heavy_zap(
        native,
        foreign,
        reserves,
        fee_params,
        -excess_scaled,
        pool,
      );
    }
    // Already balanced
    return this.#create_balanced_plan(native, foreign);
  }

  #create_empty_pool_plan(native, foreign) {
    return {
      foreign_for_swap: 0n,
      native_from_swap: 0n,
      native_to_swap: 0n,
      foreign_from_swap: 0n,
      foreign_for_liquidity: foreign,
      native_for_liquidity: native,
    };
  }

  #get_fee_parameters(pool) {
    return {
      g_num: PERMILL - pool.fee,
      g_den: PERMILL,
    };
  }

  #plan_foreign_heavy_zap(
    native,
    foreign,
    reserves,
    fee_params,
    excess_scaled,
    pool,
  ) {
    const { g_num, g_den } = fee_params;
    const a = reserves.native * g_num;
    const b =
      reserves.foreign * reserves.native * (g_den + g_num) -
      g_num * excess_scaled;
    const c = -excess_scaled * reserves.foreign * g_den;
    const discriminant = b * b - 4n * a * c;
    if (discriminant < 0n) {
      console.warn(
        "Zap formula failed: negative discriminant, falling back to balanced plan",
      );
      return this.#create_balanced_plan(native, foreign);
    }
    const s = (sqrt(discriminant) - b) / (2n * a);
    const foreign_to_swap = s > foreign ? foreign : s;
    const native_from_swap =
      foreign_to_swap > 0n
        ? pool.get_native_out_for_foreign_in(foreign_to_swap)
        : 0n;
    return {
      foreign_for_swap: foreign_to_swap,
      native_from_swap,
      native_to_swap: 0n,
      foreign_from_swap: 0n,
      foreign_for_liquidity: foreign - foreign_to_swap,
      native_for_liquidity: native + native_from_swap,
    };
  }

  #plan_native_heavy_zap(
    native,
    foreign,
    reserves,
    fee_params,
    excess_scaled,
    pool,
  ) {
    const { g_num, g_den } = fee_params;
    const a = reserves.foreign * g_num;
    const b =
      reserves.foreign * reserves.native * (g_den + g_num) -
      g_num * excess_scaled;
    const c = -excess_scaled * reserves.native * g_den;
    const discriminant = b * b - 4n * a * c;
    if (discriminant < 0n) {
      console.warn(
        "Zap formula failed: negative discriminant, falling back to balanced plan",
      );
      return this.#create_balanced_plan(native, foreign);
    }
    const s = (sqrt(discriminant) - b) / (2n * a);
    const native_to_swap = s > native ? native : s;
    const foreign_from_swap =
      native_to_swap > 0n
        ? pool.get_foreign_out_for_native_in(native_to_swap)
        : 0n;
    return {
      foreign_for_swap: 0n,
      native_from_swap: 0n,
      native_to_swap,
      foreign_from_swap,
      foreign_for_liquidity: foreign + foreign_from_swap,
      native_for_liquidity: native - native_to_swap,
    };
  }

  #create_balanced_plan(native, foreign) {
    // Ensure mutual exclusivity: never swap in both directions
    return {
      foreign_for_swap: 0n,
      native_from_swap: 0n,
      native_to_swap: 0n,
      foreign_from_swap: 0n,
      foreign_for_liquidity: foreign,
      native_for_liquidity: native,
    };
  }

  execute_zap(plan, pool) {
    const swap_results = { foreign_swap: null, native_swap: null };
    // Execute swaps in sequence
    if (plan.foreign_for_swap > 0n) {
      swap_results.foreign_swap = pool.swap_exact_foreign_for_native(
        plan.foreign_for_swap,
      );
    }
    if (plan.native_to_swap > 0n) {
      swap_results.native_swap = pool.swap_exact_native_for_foreign(
        plan.native_to_swap,
      );
    }
    // Add balanced liquidity
    const liquidity_result = this.add_pol_liquidity(
      plan.native_for_liquidity,
      plan.foreign_for_liquidity,
      pool,
    );
    return {
      ...liquidity_result,
      swaps_executed: swap_results,
      zap_plan: plan,
    };
  }
}

// === SMART ROUTER ===

class SmartRouter {
  static DEFAULT_ROUTER_FEE = 1_000n; // 0.1%
  constructor(config) {
    this.xyk_pool = config.xyk_pool;
    this.pol_manager = config.pol_manager;
    this.utbc_minter = config.utbc_minter;
    this.router_fee = config.router_fee || SmartRouter.DEFAULT_ROUTER_FEE;
    this.buyback_buffer = 0n;
    this.total_buyback_burned = 0n;
  }

  route_swap_exact_foreign_for_native(foreign_amount) {
    if (foreign_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const snapshot = { buyback_buffer: this.buyback_buffer };
    // Deduct router fee
    const fee = mul_div(foreign_amount, this.router_fee, PERMILL, true);
    const foreign_net = foreign_amount - fee;
    if (foreign_net <= 0n) {
      throw new Error("Amount too small after router fee");
    }
    this.buyback_buffer += fee;
    // Route selection: compare UTBC vs XYK
    const route_info = this.#select_best_buy_route(foreign_net);

    const buyback_result = this.#try_execute_buyback();
    return {
      route: route_info.route,
      native_out: route_info.native_out,
      foreign_in: foreign_amount,
      foreign_in_after_fee: foreign_net,
      router_fee_taken: fee,
      buyback_buffer_before: snapshot.buyback_buffer,
      buyback_buffer_after: this.buyback_buffer,
      buyback_executed: buyback_result?.executed || false,
      route_details: route_info.details,
    };
  }

  #select_best_buy_route(foreign_net) {
    const utbc_quote = this.utbc_minter.preview_mint(foreign_net);
    const xyk_native = this.xyk_pool.get_native_out_for_foreign_in(foreign_net);
    if (!utbc_quote || utbc_quote.user_native < xyk_native) {
      return this.#execute_xyk_buy_route(foreign_net, utbc_quote);
    } else {
      return this.#execute_utbc_buy_route(foreign_net, xyk_native);
    }
  }

  #execute_xyk_buy_route(foreign_net, utbc_quote) {
    const swap_result =
      this.xyk_pool.swap_exact_foreign_for_native(foreign_net);
    return {
      route: "XYK",
      native_out: swap_result.native_out,
      details: {
        swap_result,
        alternative_quote: utbc_quote?.user_native || null,
      },
    };
  }

  #execute_utbc_buy_route(foreign_net, xyk_alternative) {
    const mint_result = this.utbc_minter.mint_from_foreign(foreign_net);
    const details = {
      mint_result,
      alternative_quote: xyk_alternative,
    };
    // Handle POL liquidity provision
    if (mint_result.pol_native > 0n) {
      const zap_plan = this.pol_manager.preview_zap(
        mint_result.pol_native,
        foreign_net,
        this.xyk_pool,
      );
      if (zap_plan) {
        details.pol_result = this.pol_manager.execute_zap(
          zap_plan,
          this.xyk_pool,
        );
      }
    }
    return {
      route: "UTBC",
      native_out: mint_result.user_native,
      details,
    };
  }

  route_swap_exact_native_for_foreign(native_amount) {
    if (native_amount <= 0n) {
      throw new Error("Amount must be positive");
    }
    const snapshot = { buyback_buffer: this.buyback_buffer };
    // Execute XYK swap (only available route for selling)
    const swap_result =
      this.xyk_pool.swap_exact_native_for_foreign(native_amount);
    const foreign_gross = swap_result.foreign_out;
    // Deduct router fee from output
    const fee = mul_div(foreign_gross, this.router_fee, PERMILL, true);
    const foreign_net = foreign_gross - fee;
    if (foreign_net <= 0n) {
      throw new Error("Output too small after router fee");
    }
    this.buyback_buffer += fee;
    const buyback_result = this.#try_execute_buyback();
    return {
      route: "XYK",
      foreign_out: foreign_net,
      foreign_out_before_fee: foreign_gross,
      native_in: native_amount,
      router_fee_taken: fee,
      buyback_buffer_before: snapshot.buyback_buffer,
      buyback_buffer_after: this.buyback_buffer,
      buyback_executed: buyback_result?.executed || false,
      route_details: { swap_result },
    };
  }

  execute_buyback() {
    if (this.buyback_buffer === 0n) {
      return { executed: false, native_burned: 0n, foreign_spent: 0n };
    }
    // Execute buyback and burn
    const swap_result = this.xyk_pool.swap_exact_foreign_for_native(
      this.buyback_buffer,
    );
    const native_bought = swap_result.native_out;
    this.utbc_minter.burn_native(native_bought);
    const foreign_spent = this.buyback_buffer;
    this.buyback_buffer = 0n;
    this.total_buyback_burned += native_bought;
    return {
      executed: true,
      native_burned: native_bought,
      foreign_spent: foreign_spent,
    };
  }

  #try_execute_buyback() {
    return this.buyback_buffer > 0n
      ? this.execute_buyback()
      : { executed: false };
  }

  quote_best_route_for_buy(foreign_amount) {
    if (foreign_amount <= 0n) {
      return null;
    }
    const router_fee = mul_div(foreign_amount, this.router_fee, PERMILL, true);
    const foreign_net = foreign_amount - router_fee;
    if (foreign_net <= 0n) {
      return null;
    }
    const utbc_quote = this.utbc_minter.preview_mint(foreign_net);
    const xyk_native = this.xyk_pool.get_native_out_for_foreign_in(foreign_net);
    const utbc_native = utbc_quote?.user_native || 0n;
    const is_utbc_better = utbc_quote && utbc_native >= xyk_native;
    const native_out = is_utbc_better ? utbc_native : xyk_native;
    return {
      best_route: is_utbc_better ? "UTBC" : "XYK",
      native_out,
      foreign_in: foreign_amount,
      foreign_in_after_fee: foreign_net,
      router_fee,
      routes_compared: {
        utbc: utbc_native,
        xyk: xyk_native,
      },
    };
  }

  quote_sell_route(native_amount) {
    if (native_amount <= 0n) {
      return null;
    }
    // Only XYK available for selling
    const foreign_gross =
      this.xyk_pool.get_foreign_out_for_native_in(native_amount);
    if (foreign_gross <= 0n) {
      return null;
    }
    const router_fee = mul_div(foreign_gross, this.router_fee, PERMILL, true);
    const foreign_net = foreign_gross - router_fee;
    if (foreign_net <= 0n) {
      return null;
    }
    return {
      route: "XYK",
      foreign_out: foreign_net,
      foreign_out_before_fee: foreign_gross,
      native_in: native_amount,
      router_fee,
    };
  }
}

const DEFAULT_CONFIG = {
  initial_price: 1_000_000_000n, // 0.001 per token
  slope: 1_000n, // 0.000001 absolute linear price increase per token
  xyk_fee: 3_000n, // 0.3%
  router_fee: 2_000n, // 0.2%
  shares: UtbcMinter.DEFAULT_SHARES,
};

export const createSystem = (user_config = {}) => {
  const config = { ...DEFAULT_CONFIG, ...user_config };
  const xyk_pool = new XykPool(config.xyk_fee);
  const pol_manager = new PolManager();
  const utbc_minter = new UtbcMinter(
    config.initial_price,
    config.slope,
    config.shares,
  );
  const router = new SmartRouter({
    xyk_pool,
    pol_manager,
    utbc_minter,
    router_fee: config.router_fee,
  });
  return { xyk_pool, pol_manager, utbc_minter, router };
};
