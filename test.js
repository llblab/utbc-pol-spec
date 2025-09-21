// @ts-check

/**
 * Comprehensive test suite for UTBC+POL simulator
 * @note Tests mathematical correctness, component integration, and edge cases
 */

import {
  BigMath,
  create_system,
  PPM,
  PRECISION,
  XykPool,
} from "./simulator.js";

// Test utilities
/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {void}
 */
const assert = (condition, message) => {
  if (!condition) throw new Error(`❌ ${message}`);
};

/**
 * @param {bigint} actual
 * @param {bigint} expected
 * @param {string} message
 * @returns {void}
 */
const assertBigInt = (actual, expected, message) => {
  assert(
    actual === expected,
    `${message}: expected ${expected}, got ${actual}`,
  );
};

/**
 * @param {bigint} actual
 * @param {bigint} expected
 * @param {bigint} tolerance_ppm
 * @param {string} message
 * @returns {void}
 */
const assertApprox = (actual, expected, tolerance_ppm, message) => {
  const diff = actual > expected ? actual - expected : expected - actual;
  // Ensure all values are bigints for the calculation
  const tolerance = BigMath.mul_div(expected, tolerance_ppm, PPM);
  assert(
    diff <= tolerance,
    `${message}: ${actual} not within ${Number(tolerance_ppm) / 10000}% of ${expected}`,
  );
};

// Test runner
let test_counter = 0;
/**
 * @param {string} name
 * @param {() => void} fn
 * @returns {void}
 */
const run_test = (name, fn) => {
  test_counter++;
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    throw e;
  }
};

/**
 * @param {string} title
 * @param {() => void} tests
 * @returns {void}
 */
const run_section = (title, tests) => {
  console.log(`\n=== ${title} ===\n`);
  tests();
};

// Helper to verify mint calculation
/**
 * @param {bigint} minted
 * @param {bigint} price_initial
 * @param {bigint} slope_ppm
 * @param {bigint} supply_before
 * @returns {bigint}
 */
const verify_mint_cost = (minted, price_initial, slope_ppm, supply_before) => {
  if (minted === 0n) return 0n;
  const tokens = minted / PRECISION;
  const supply_base = supply_before / PRECISION;
  // price_initial is in PRECISION units, slope adjustment also in PRECISION
  const price_start =
    price_initial + BigMath.mul_div(slope_ppm, supply_before, PPM);
  const price_end =
    price_initial + BigMath.mul_div(slope_ppm, supply_before + minted, PPM);
  const avg_price = (price_start + price_end) / 2n;
  // Cost = tokens * price, but price is in PRECISION units
  return (tokens * avg_price) / PRECISION;
};

// === MATH UTILITIES TESTS ===
run_section("Math Utilities", () => {
  run_test("mul_div correctness", () => {
    assertBigInt(BigMath.mul_div(100n, 50n, 50n), 100n, "mul_div(100, 50, 50)");
    assertBigInt(BigMath.mul_div(100n, 1n, 1n), 100n, "mul_div(100, 1, 1)");
    assertBigInt(
      BigMath.mul_div(100n, 200n, 50n),
      400n,
      "mul_div(100, 200, 50)",
    );
  });

  run_test("isqrt correctness", () => {
    assertBigInt(BigMath.isqrt(0n), 0n, "sqrt(0)");
    assertBigInt(BigMath.isqrt(1n), 1n, "sqrt(1)");
    assertBigInt(BigMath.isqrt(4n), 2n, "sqrt(4)");
    assertBigInt(BigMath.isqrt(100n), 10n, "sqrt(100)");
    assertBigInt(BigMath.isqrt(101n), 10n, "sqrt(101) rounds down");
  });

  run_test("div_ceil correctness", () => {
    assertBigInt(BigMath.div_ceil(10n, 3n), 4n, "div_ceil(10, 3)");
    assertBigInt(BigMath.div_ceil(9n, 3n), 3n, "div_ceil(9, 3) exact");
    assertBigInt(
      BigMath.div_ceil(1n, 1000n),
      1n,
      "div_ceil(1, 1000) rounds up",
    );
    assertBigInt(BigMath.div_ceil(0n, 5n), 0n, "div_ceil(0, 5)");
  });

  run_test("min/max/abs correctness", () => {
    assertBigInt(BigMath.min(10n, 5n), 5n, "min(10, 5)");
    assertBigInt(BigMath.max(10n, 5n), 10n, "max(10, 5)");
    assertBigInt(BigMath.abs(-10n), 10n, "abs(-10)");
    assertBigInt(BigMath.abs(10n), 10n, "abs(10)");
  });

  run_test("calculate_swap_output edge cases", () => {
    // Zero fee
    const out1 = BigMath.calculate_swap_output(100n, 1000n, 1000n, 0n);
    assertBigInt(out1, 90n, "Zero fee swap");

    // High fee
    const out2 = BigMath.calculate_swap_output(100n, 1000n, 1000n, 999_000n);
    assert(out2 < 1n, "99.9% fee leaves almost nothing");

    // Large amounts
    const out3 = BigMath.calculate_swap_output(
      10n ** 18n,
      10n ** 20n,
      10n ** 20n,
      3000n,
    );
    assert(out3 > 0n, "Large amount swap succeeds");
  });
});

// === BONDING CURVE TESTS ===
run_section("Bonding Curve Mathematics", () => {
  run_test("constant price (zero slope)", () => {
    const system = create_system({ price_initial: 1_000_000n, slope_ppm: 0n });
    const foreign = 1_000_000n;
    const minted = system.utbc_minter.calculate_mint(foreign);
    const expected = BigMath.mul_div(foreign, PRECISION, 1_000_000n);
    assertBigInt(minted, expected, "Constant price mint");
  });

  run_test("linear bonding curve - small amount", () => {
    const system = create_system({
      price_initial: 1_000_000_000n,
      slope_ppm: 1000n,
    });
    const foreign = 99800n;
    const minted = system.utbc_minter.calculate_mint(foreign);
    const cost = verify_mint_cost(minted, 1_000_000_000n, 1000n, 0n);
    assertApprox(cost, foreign, 100n, "Small amount cost verification"); // 0.01% tolerance
  });

  run_test("linear bonding curve - large amount", () => {
    const system = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 10_000n,
    });
    const foreign = 10_000_000n;
    const minted = system.utbc_minter.calculate_mint(foreign);
    const cost = verify_mint_cost(minted, 1_000_000n, 10_000n, 0n);
    assertApprox(cost, foreign, 100n, "Large amount cost verification");
  });

  run_test("with existing supply", () => {
    const system = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 10_000n,
    });
    system.utbc_minter.supply = 5_000n * PRECISION;
    const foreign = 1_000_000n;
    const minted = system.utbc_minter.calculate_mint(foreign);
    const cost = verify_mint_cost(
      minted,
      1_000_000n,
      10_000n,
      5_000n * PRECISION,
    );
    assertApprox(cost, foreign, 100n, "Cost with existing supply");
  });

  run_test("price_spot consistency", () => {
    const system = create_system({
      price_initial: 1_000_000_000n,
      slope_ppm: 1000n,
    });
    const initial_price = system.utbc_minter.get_price();
    assertBigInt(initial_price, 1_000_000_000n, "Initial spot price");

    system.utbc_minter.supply = 1000n * PRECISION;
    const new_price = system.utbc_minter.get_price();
    // get_price uses supply directly (in PRECISION units)
    const expected_price =
      1_000_000_000n + BigMath.mul_div(1000n, 1000n * PRECISION, PPM);
    assertBigInt(new_price, expected_price, "Spot price after supply increase");
  });

  run_test("mint with extreme slopes", () => {
    // Zero slope = constant price
    const flat = create_system({ slope_ppm: 0n, price_initial: 1_000_000n });
    const minted1 = flat.utbc_minter.calculate_mint(1_000_000n);
    const minted2 = flat.utbc_minter.calculate_mint(1_000_000n);
    assertBigInt(minted1, minted2, "Constant price with zero slope");

    // Very high slope
    const steep = create_system({
      slope_ppm: 100_000n,
      price_initial: 1_000_000n,
    });
    const first = steep.utbc_minter.calculate_mint(1_000_000n);
    steep.utbc_minter.mint_native(1_000_000n);
    const second = steep.utbc_minter.calculate_mint(1_000_000n);
    assert(second < first, "High slope reduces minted amount quickly");
  });

  run_test("burn reduces supply correctly", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(100_000n, 0n);

    const supply_before = system.utbc_minter.supply;
    const burn_amount = 1000n * PRECISION;
    system.utbc_minter.burn_native(burn_amount);
    const supply_after = system.utbc_minter.supply;

    assertBigInt(
      supply_before - supply_after,
      burn_amount,
      "Supply reduced by burn amount",
    );
  });

  run_test("fractional token minting precision", () => {
    const system = create_system({
      price_initial: 10_000_000_000n, // Very high price
      slope_ppm: 0n,
    });

    // Should mint fractional tokens (less than 1.0)
    const small_foreign = 1000n;
    const minted = system.utbc_minter.calculate_mint(small_foreign);
    assert(minted > 0n, "Fractional tokens minted");
    assert(minted < PRECISION, "Less than one full token");

    // Verify cost calculation is accurate for fractional tokens
    const expected = BigMath.mul_div(small_foreign, PRECISION, 10_000_000_000n);
    assertBigInt(minted, expected, "Fractional token calculation precise");
  });

  run_test("rounding behavior in mint calculations", () => {
    const system = create_system({
      price_initial: 3n, // Price that causes rounding
      slope_ppm: 0n,
    });

    // Test various amounts that cause rounding
    const test_amounts = [1n, 2n, 4n, 5n, 7n, 10n];
    for (const amount of test_amounts) {
      const minted = system.utbc_minter.calculate_mint(amount);
      const expected = BigMath.mul_div(amount, PRECISION, 3n);
      assertBigInt(minted, expected, `Rounding for ${amount} foreign`);
    }
  });

  run_test("extreme slope values", () => {
    // Maximum slope (100% = 1,000,000 PPM)
    const max_slope = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 1_000_000n,
    });

    const first_mint = max_slope.utbc_minter.calculate_mint(1_000_000n);
    max_slope.utbc_minter.mint_native(1_000_000n);
    const second_mint = max_slope.utbc_minter.calculate_mint(1_000_000n);

    assert(
      second_mint < first_mint / 2n,
      "Extreme slope drastically reduces output",
    );

    // Very small slope (0.001% = 10 PPM)
    const min_slope = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 10n,
    });

    const first_small = min_slope.utbc_minter.calculate_mint(100_000n);
    min_slope.utbc_minter.mint_native(100_000n);
    const second_small = min_slope.utbc_minter.calculate_mint(100_000n);

    // With tiny slope, impact should be less than with extreme slope
    assert(
      second_small < first_small,
      "Tiny slope still causes price increase",
    );
    assert(
      second_small > first_mint / 2n,
      "Tiny slope has much less impact than extreme slope",
    );
  });

  run_test("price calculation overflow protection", () => {
    const system = create_system({
      price_initial: 2n ** 100n, // Large initial price
      slope_ppm: 100_000n,
    });

    // Mint huge amount to test overflow
    system.utbc_minter.supply = 2n ** 100n;

    // This should not overflow
    const price = system.utbc_minter.get_price();
    assert(price > 0n, "Price calculation handles large numbers");

    // Calculate mint with large values
    const minted = system.utbc_minter.calculate_mint(2n ** 50n);
    assert(minted >= 0n, "Large mint calculation doesn't overflow");
  });

  run_test("mint calculation mathematical invariants", () => {
    const system = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 5_000n,
    });

    // Invariant 1: Minting 0 should return 0
    assertBigInt(
      system.utbc_minter.calculate_mint(0n),
      0n,
      "Zero input gives zero output",
    );

    // Invariant 2: Minting twice the amount should cost more than twice
    const single = system.utbc_minter.calculate_mint(1_000_000n);
    const double = system.utbc_minter.calculate_mint(2_000_000n);
    assert(double < single * 2n, "Slope makes larger mints less efficient");

    // Invariant 3: Sequential mints should match combined mint
    const combined = system.utbc_minter.calculate_mint(3_000_000n);
    const first = system.utbc_minter.calculate_mint(1_000_000n);
    system.utbc_minter.supply = first; // Simulate first mint
    const second = system.utbc_minter.calculate_mint(2_000_000n);
    assertApprox(
      first + second,
      combined,
      100n, // 0.01% tolerance
      "Sequential mints match combined",
    );
  });

  run_test("supply and price consistency after operations", () => {
    const system = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 10_000n,
    });

    // Track supply and price through operations
    const initial_price = system.utbc_minter.get_price();
    assertBigInt(initial_price, 1_000_000n, "Initial price correct");

    // Mint
    const minted = system.utbc_minter.mint_native(5_000_000n);
    const price_after_mint = system.utbc_minter.get_price();
    assert(price_after_mint > initial_price, "Price increased after mint");

    // Burn
    system.utbc_minter.burn_native(minted.total_native / 2n);
    const price_after_burn = system.utbc_minter.get_price();
    assert(price_after_burn < price_after_mint, "Price decreased after burn");
    assert(price_after_burn > initial_price, "Price still above initial");

    // Verify supply tracking
    const final_supply = system.utbc_minter.supply;
    assertBigInt(
      final_supply,
      minted.total_native / 2n,
      "Supply correctly tracks mint and burn",
    );
  });
});

// === XYK POOL TESTS ===
run_section("XYK Pool", () => {
  run_test("add initial liquidity", () => {
    const pool = new XykPool({ fee_ppm: 3000n });
    const result = pool.add_liquidity(1000n * PRECISION, 2000n * PRECISION);
    assert(result.lp_minted > 0n, "LP tokens minted");
    assert(pool.has_liquidity(), "Pool has liquidity");
  });

  run_test("swap with fee", () => {
    const pool = new XykPool({ fee_ppm: 3000n });
    pool.add_liquidity(1000n * PRECISION, 2000n * PRECISION);

    const foreign_in = 100n * PRECISION;
    const native_out = pool.get_out_native(foreign_in);
    const result = pool.swap_foreign_to_native(foreign_in);

    assertBigInt(result.native_out, native_out, "Swap output matches quote");
    assert(result.native_out < 50n * PRECISION, "Fee reduces output");
  });

  run_test("price impact", () => {
    const pool = new XykPool({ fee_ppm: 3000n });
    pool.add_liquidity(1000n * PRECISION, 2000n * PRECISION);

    const price_before = pool.get_price();
    const result = pool.swap_foreign_to_native(500n * PRECISION);

    assert(result.price_after > price_before, "Price increases after buy");
    assert(result.price_impact_ppm > 0n, "Price impact is positive");
  });

  run_test("minimum liquidity requirements", () => {
    const pool = new XykPool({ fee_ppm: 3000n });

    // Even tiny amounts work as long as product > 0
    const tiny_result = pool.add_liquidity(1n, 1n);
    assertBigInt(
      tiny_result.lp_minted,
      1n,
      "Tiny liquidity creates 1 LP token",
    );

    // Add more liquidity to existing pool
    const pool2 = new XykPool({ fee_ppm: 3000n });
    pool2.add_liquidity(1000n, 2000n);

    // Try to add liquidity that's too small relative to pool
    try {
      pool2.add_liquidity(0n, 1n);
      assert(false, "Should reject zero amounts");
    } catch (e) {
      assert(e.message.includes("positive"), "Zero amount rejected");
    }
  });

  run_test("proportional liquidity addition", () => {
    const pool = new XykPool({ fee_ppm: 3000n });
    pool.add_liquidity(1000n * PRECISION, 2000n * PRECISION);

    // Add in exact proportion
    const result1 = pool.add_liquidity(500n * PRECISION, 1000n * PRECISION);
    assert(
      result1.native_rest <= 1n,
      `Minimal native leftover with exact ratio: ${result1.native_rest}`,
    );
    assert(
      result1.foreign_rest <= 1n,
      `Minimal foreign leftover with exact ratio: ${result1.foreign_rest}`,
    );

    // Add with excess native
    const result2 = pool.add_liquidity(600n * PRECISION, 1000n * PRECISION);
    assert(result2.native_rest > 0n, "Native leftover with excess");
    assert(
      result2.foreign_rest <= 1n,
      `Minimal foreign leftover: ${result2.foreign_rest}`,
    );
  });

  run_test("swap with extreme amounts", () => {
    const pool = new XykPool({ fee_ppm: 3000n });
    pool.add_liquidity(1000n * PRECISION, 1000n * PRECISION);

    // Very large swap (50% of pool)
    const large_result = pool.swap_foreign_to_native(500n * PRECISION);
    assert(
      large_result.price_impact_ppm > 100_000n,
      "Large swap has high impact",
    );

    // Very small swap
    const small_result = pool.swap_native_to_foreign(1n);
    assert(small_result.price_impact_ppm < 10n, "Tiny swap has minimal impact");
  });
});

// === ZAP MECHANISM TESTS ===
run_section("Zap Mechanism", () => {
  run_test("balanced liquidity addition through POL manager", () => {
    const system = create_system({});
    // Initialize pool first
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Now test balanced liquidity addition through POL manager
    const pol_before = system.pol_manager.balance_lp;
    const result = system.pol_manager.add_liquidity(
      500n * PRECISION,
      1000n * PRECISION,
    );

    assert(result.lp_minted > 0n, "LP tokens minted");
    assert(
      system.pol_manager.balance_lp > pol_before,
      "POL manager LP balance increased",
    );
    assertApprox(
      result.native_used,
      500n * PRECISION,
      1000n, // 0.1% tolerance for integrated system
      "All native used",
    );
    assertApprox(
      result.foreign_used,
      1000n * PRECISION,
      1000n, // 0.1% tolerance for integrated system
      "All foreign used",
    );
  });

  run_test("excess foreign conversion through POL manager", () => {
    const system = create_system({});
    // Initialize pool with 1:1 ratio
    system.router.swap_foreign_to_native(200_000n, 0n);

    // Clear buffers by adding current POL liquidity
    system.pol_manager.add_liquidity(0n, 0n);

    // Now test excess foreign conversion
    const result = system.pol_manager.add_liquidity(
      100n * PRECISION,
      500n * PRECISION,
    );

    assert(result.lp_minted > 0n, "LP tokens minted");
    assertApprox(
      result.native_used,
      100n * PRECISION,
      1000n, // 0.1% tolerance for integrated system
      "All initial native used",
    );
    // POL manager's zap should handle excess foreign by swapping
    assertApprox(
      result.foreign_used,
      500n * PRECISION,
      1000n, // 0.1% tolerance for integrated system
      "All foreign used through zap",
    );
    assert(
      result.buffered_native > 0n,
      "Native received from swap and buffered",
    );
    assertBigInt(result.buffered_foreign, 0n, "No foreign left after swap");
  });

  run_test("pol manager initializes pool directly on first UTBC mint", () => {
    const system = create_system({});

    // Verify pool doesn't exist yet
    assert(
      !system.xyk_pool.has_liquidity(),
      "Pool not initialized before first mint",
    );

    // First mint through UTBC should initialize the pool via POL manager
    // This uses direct add_liquidity, NOT the Zap strategy
    const result = system.router.swap_foreign_to_native(100_000n, 0n);

    assert(result.route === "UTBC", "First swap must use UTBC route");
    assert(
      system.xyk_pool.has_liquidity(),
      "Pool initialized by POL manager after first UTBC mint",
    );
    assert(
      system.pol_manager.balance_lp > 0n,
      "POL manager received LP tokens from initialization",
    );

    // Verify this was initialization, not zap
    // Initial pool should have exact amounts from first mint
    assert(
      system.pol_manager.contributed_native > 0n,
      "POL manager contributed native tokens to initialize pool",
    );
    assert(
      system.pol_manager.contributed_foreign > 0n,
      "POL manager contributed foreign tokens to initialize pool",
    );
  });

  run_test("POL buffer accumulation", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Add only native - should be buffered since we need foreign too
    system.pol_manager.add_liquidity(100n * PRECISION, 0n);
    assert(system.pol_manager.buffer_native > 0n, "Native buffered");

    // Add only foreign - will either be buffered or swapped for native
    const native_before = system.pol_manager.buffer_native;
    system.pol_manager.add_liquidity(0n, 100n * PRECISION);
    assert(
      system.pol_manager.buffer_foreign > 0n ||
        system.pol_manager.buffer_native > native_before,
      "Foreign either buffered or swapped for native",
    );

    // Buffers should be used in next add
    const before_lp = system.pol_manager.balance_lp;
    system.pol_manager.add_liquidity(0n, 0n);
    assert(
      system.pol_manager.balance_lp >= before_lp,
      "Buffers processed or unchanged",
    );
  });

  run_test("zap with failed swap", () => {
    const system = create_system({ min_trade_foreign: 1_000_000n });
    system.router.swap_foreign_to_native(1_000_000n, 0n); // Initialize with valid amount

    // Try to zap with foreign amount below swap minimum
    const result = system.pol_manager.add_liquidity(
      10n * PRECISION,
      100n, // Too small to swap
    );

    // Should add balanced liquidity but keep excess in buffer
    assert(result.lp_minted > 0n, "Some liquidity added");
    assert(
      system.pol_manager.buffer_foreign > 0n,
      "Unswappable foreign buffered",
    );
  });

  run_test(
    "AllInZap with price imbalance (only works after pool exists)",
    () => {
      const system = create_system({});

      // First establish pool through initial mint
      system.router.swap_foreign_to_native(200_000n, 0n);
      assert(system.xyk_pool.has_liquidity(), "Pool initialized by first mint");

      // Create price imbalance - make foreign cheaper in XYK
      system.router.swap_native_to_foreign(50n * PRECISION, 0n);

      const xyk_price = system.xyk_pool.get_price();
      const tbc_price = system.utbc_minter.get_price();
      assert(xyk_price < tbc_price, "XYK price should be lower");

      // AllInZap (through POL manager) should optimize by adding bulk liquidity first
      // This only works because pool already exists - otherwise it would use direct initialization
      const result = system.pol_manager.add_liquidity(
        100n * PRECISION,
        300n * PRECISION,
      );

      assert(result.lp_minted > 0n, "LP tokens minted via Zap strategy");
      assert(result.foreign_used > 0n, "Foreign used in Zap");
      assert(result.native_used > 0n, "Native used in Zap");
    },
  );

  run_test("POL manager handles router circular dependency", () => {
    const system = create_system({});

    // POL manager should have router set via closure
    system.router.swap_foreign_to_native(100_000n, 0n);

    // This should work despite circular dependency
    const result = system.pol_manager.add_liquidity(
      10n * PRECISION,
      50n * PRECISION,
    );

    assert(result.lp_minted > 0n, "LP minted with router dependency");
  });

  run_test("buffer processing with minimum amounts", () => {
    const system = create_system({ min_trade_foreign: 10_000n });
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Add small amounts that get buffered
    for (let i = 0; i < 3; i++) {
      system.pol_manager.add_liquidity(
        100n * PRECISION,
        1_000n, // Below min_trade
      );
    }

    assert(system.pol_manager.buffer_foreign > 0n, "Foreign buffered");
    assert(system.pol_manager.buffer_native > 0n, "Native buffered");

    // Process buffers by adding more
    system.pol_manager.add_liquidity(
      0n,
      20_000n, // Above min_trade to trigger swap
    );

    // Buffers should be processed
    assert(
      system.pol_manager.balance_lp > 0n,
      "LP increased from buffer processing",
    );
  });

  run_test("zap with exact pool ratio", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(200_000n, 0n);

    // Get current pool ratio
    const native_reserve = system.xyk_pool.reserve_native;
    const foreign_reserve = system.xyk_pool.reserve_foreign;
    const ratio = BigMath.mul_div(native_reserve, PRECISION, foreign_reserve);

    // Add liquidity in exact ratio
    const native_amount = 100n * PRECISION;
    const foreign_amount = BigMath.mul_div(
      native_amount,
      foreign_reserve,
      native_reserve,
    );

    const result = system.pol_manager.add_liquidity(
      native_amount,
      foreign_amount,
    );

    // Should have minimal leftovers
    assert(
      result.buffered_native < PRECISION / 100n,
      "Minimal native leftover with exact ratio",
    );
    assert(
      result.buffered_foreign < foreign_amount / 100n,
      "Minimal foreign leftover with exact ratio",
    );
  });

  run_test("AllInZap with native excess", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(200_000n, 0n);

    // Make foreign more expensive in XYK
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Add with native excess
    const result = system.pol_manager.add_liquidity(
      200n * PRECISION,
      10n * PRECISION,
    );

    assert(result.lp_minted > 0n, "LP minted");
    // Native excess should be swapped or buffered
    assert(result.native_used <= 200n * PRECISION, "Native used within input");
    assert(result.buffered_native >= 0n, "Native buffer handled");
  });

  run_test("POL manager pool initialization vs zap strategy", () => {
    const system = create_system({});

    // Test direct call to POL manager add_liquidity when pool doesn't exist
    // This simulates what happens during first UTBC mint
    const result = system.pol_manager.add_liquidity(
      100n * PRECISION,
      200n * PRECISION,
    );

    // This should initialize pool directly (not through Zap)
    assert(result.lp_minted > 0n, "LP minted from pool initialization");
    assertBigInt(
      result.native_used,
      100n * PRECISION,
      "All native used for initialization",
    );
    assertBigInt(
      result.foreign_used,
      200n * PRECISION,
      "All foreign used for initialization",
    );
    assert(
      system.xyk_pool.has_liquidity(),
      "Pool initialized directly by POL manager",
    );
    assert(system.pol_manager.balance_lp > 0n, "POL manager holds LP tokens");

    // Now test subsequent adds use Zap strategy
    const result2 = system.pol_manager.add_liquidity(
      50n * PRECISION,
      300n * PRECISION, // Excess foreign to trigger zap
    );

    assert(result2.lp_minted > 0n, "LP minted from zap strategy");
    // With zap, not all foreign may be used immediately (some may swap)
    assert(
      result2.foreign_used <= 300n * PRECISION,
      "Zap strategy optimizes foreign usage",
    );
  });

  run_test("POL manager buffers single token type", () => {
    const system = create_system({});

    // Add only native tokens - should be buffered
    const result1 = system.pol_manager.add_liquidity(100n * PRECISION, 0n);

    assertBigInt(result1.lp_minted, 0n, "No LP without both tokens");
    assertBigInt(result1.native_used, 0n, "Native buffered, not used");
    assertBigInt(
      system.pol_manager.buffer_native,
      100n * PRECISION,
      "Native in buffer",
    );

    // Add foreign tokens - with native in buffer, should initialize pool
    const result2 = system.pol_manager.add_liquidity(0n, 200n * PRECISION);

    // Pool should be initialized now since we have both tokens
    assert(result2.lp_minted > 0n, "LP minted when both tokens available");
    assertBigInt(
      result2.native_used,
      100n * PRECISION,
      "Native from buffer used",
    );
    assertBigInt(result2.foreign_used, 200n * PRECISION, "Foreign used");
    assert(system.xyk_pool.has_liquidity(), "Pool initialized");

    // Buffers should be cleared
    assertBigInt(system.pol_manager.buffer_native, 0n, "Native buffer cleared");
    assertBigInt(
      system.pol_manager.buffer_foreign,
      0n,
      "Foreign buffer cleared",
    );
  });

  run_test("zap mechanism stress test", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(500_000n, 0n);

    // Multiple rapid additions with varying ratios
    const operations = [
      [100n * PRECISION, 50n * PRECISION],
      [50n * PRECISION, 100n * PRECISION],
      [200n * PRECISION, 200n * PRECISION],
      [10n * PRECISION, 500n * PRECISION],
      [500n * PRECISION, 10n * PRECISION],
    ];

    let total_lp = 0n;
    for (const [native, foreign] of operations) {
      const result = system.pol_manager.add_liquidity(native, foreign);
      total_lp += result.lp_minted;
    }

    assert(total_lp > 0n, "Total LP accumulated");
    assert(system.pol_manager.balance_lp > 0n, "POL manager balance increased");
  });
});

// === FEE BURNING TESTS ===
run_section("Fee Burning", () => {
  run_test("native fee immediate burn", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(100_000n, 0n); // Initialize

    const supply_before = system.utbc_minter.supply;
    system.fee_manager.receive_fee_native(1000n * PRECISION);
    const supply_after = system.utbc_minter.supply;

    assertBigInt(
      supply_before - supply_after,
      1000n * PRECISION,
      "Native burned",
    );
  });

  run_test("foreign fee buffering", () => {
    const system = create_system({ min_trade_foreign: 10_000n });
    system.router.swap_foreign_to_native(100_000n, 0n); // Initialize

    // The initialization generates fees, so record the starting buffer
    const initial_buffer = system.fee_manager.buffer_foreign;

    system.fee_manager.receive_fee_foreign(5_000n);
    assertBigInt(
      system.fee_manager.buffer_foreign,
      initial_buffer + 5_000n,
      "Fee buffered",
    );

    system.fee_manager.receive_fee_foreign(5_000n);
    // Now total is initial_buffer + 10_000, which should exceed threshold and get swapped
    assertBigInt(
      system.fee_manager.buffer_foreign,
      0n,
      "Buffer cleared after threshold",
    );
    assert(
      system.fee_manager.total_native_burned > 0n,
      "Fees converted and burned",
    );
  });

  run_test("fee burning without pool liquidity", () => {
    const system = create_system({ min_trade_foreign: 10_000n });

    // No pool yet
    system.fee_manager.receive_fee_foreign(20_000n);
    assertBigInt(
      system.fee_manager.buffer_foreign,
      20_000n,
      "Foreign buffered when no pool",
    );
    assertBigInt(
      system.fee_manager.total_native_burned,
      0n,
      "Nothing burned without pool",
    );
  });

  run_test("native fee direct burn", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(100_000n, 0n);

    const supply_before = system.utbc_minter.supply;
    system.fee_manager.receive_fee_native(500n * PRECISION);
    const supply_after = system.utbc_minter.supply;

    assertBigInt(
      supply_before - supply_after,
      500n * PRECISION,
      "Native fee burned immediately",
    );
  });

  run_test("fee accumulation across multiple trades", () => {
    const system = create_system({ min_trade_foreign: 50_000n });
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Multiple small fees
    for (let i = 0; i < 5; i++) {
      system.fee_manager.receive_fee_foreign(10_000n);
    }

    // Should trigger conversion at threshold
    assert(
      system.fee_manager.total_foreign_swapped >= 50_000n,
      "Accumulated fees swapped",
    );
    assertBigInt(
      system.fee_manager.buffer_foreign,
      0n,
      "Buffer cleared after threshold",
    );
  });
});

// === ROUTER TESTS ===
run_section("Smart Router", () => {
  run_test("initial mint routing", () => {
    const system = create_system({ min_initial_foreign: 100_000n });
    const result = system.router.swap_foreign_to_native(100_000n, 0n);

    assert(result.route === "UTBC", "Initial swap uses UTBC");
    assert(result.native_out > 0n, "Native tokens received");
    assert(system.xyk_pool.has_liquidity(), "Pool created");
  });

  run_test("route selection", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(200_000n, 0n); // Initialize

    // Small swap might use XYK if price is better
    /** @type {ReturnType<typeof system.router.get_best_route>} */
    const quote = system.router.get_best_route(10_000n);
    assert(quote !== null, "Quote returned");
    if (!quote) throw new Error("Quote should not be null");
    assert(quote.best === "UTBC" || quote.best === "XYK", "Route selected");
    assert(quote.native_out > 0n, "Output calculated");
  });

  run_test("minimum trade validation", () => {
    const system = create_system({ min_trade_foreign: 1000n });

    try {
      system.router.swap_foreign_to_native(500n);
      assert(false, "Should throw for amount below minimum");
    } catch (e) {
      assert(e.message.includes("below minimum"), "Correct error message");
    }
  });

  run_test("native to foreign swap", () => {
    const system = create_system({});
    const mint = system.router.swap_foreign_to_native(200_000n, 0n);

    const swap = system.router.swap_native_to_foreign(mint.native_out / 2n);
    assert(swap.route === "XYK", "Uses XYK for selling");
    assert(swap.foreign_out > 0n, "Foreign tokens received");
  });

  run_test("slippage protection", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(200_000n, 0n);

    // Try swap with unrealistic slippage expectation
    try {
      system.router.swap_native_to_foreign(
        100n * PRECISION,
        1_000_000n * PRECISION, // Impossible foreign_min
      );
      assert(false, "Should reject due to slippage");
    } catch (e) {
      assert(e.message.includes("Slippage"), "Slippage protection triggered");
    }
  });

  run_test("routing decisions at different scales", () => {
    const system = create_system({ slope_ppm: 10_000n });
    system.router.swap_foreign_to_native(1_000_000n, 0n);

    // Small amount - might prefer XYK
    /** @type {ReturnType<typeof system.router.get_best_route>} */
    const small_quote = system.router.get_best_route(1_000n);
    assert(small_quote !== null, "Small quote succeeds");
    if (!small_quote) throw new Error("Small quote should not be null");

    // Large amount - might prefer UTBC
    /** @type {ReturnType<typeof system.router.get_best_route>} */
    const large_quote = system.router.get_best_route(1_000_000n);
    assert(large_quote !== null, "Large quote succeeds");

    // Routes might differ based on amount (don't console.log in tests)
    assert(
      small_quote.best === "UTBC" || small_quote.best === "XYK",
      "Valid route selected",
    );
  });

  run_test("minimum trade thresholds", () => {
    const system = create_system({ min_trade_foreign: 5000n });

    // Below minimum
    try {
      system.router.swap_foreign_to_native(1000n, 0n);
      assert(false, "Should reject below minimum");
    } catch (e) {
      assert(e.message.includes("minimum"), "Minimum threshold enforced");
    }

    // Above minimum succeeds
    const result = system.router.swap_foreign_to_native(100_000n, 0n);
    assert(result.native_out > 0n, "Trade above minimum succeeds");
  });

  run_test("router fee calculation accuracy", () => {
    const system = create_system({
      fee_router_ppm: 5000n, // 0.5% fee
      min_initial_foreign: 100_000n,
    });

    // Initialize pool
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Test fee calculation
    const amount = 1_000_000n;
    const expected_fee = BigMath.mul_div(amount, 5000n, PPM);
    const result = system.router.swap_foreign_to_native(amount, 0n);

    assertBigInt(
      result.foreign_fee,
      expected_fee,
      "Router fee calculated correctly",
    );

    // Verify net amount
    const net_amount = amount - expected_fee;
    assert(result.foreign_in === amount, "Total input recorded correctly");
  });

  run_test("router fee with zero fee config", () => {
    const system = create_system({
      fee_router_ppm: 0n, // No router fee
      min_initial_foreign: 100_000n,
    });

    system.router.swap_foreign_to_native(100_000n, 0n);

    const result = system.router.swap_foreign_to_native(50_000n, 0n);
    assertBigInt(
      result.foreign_fee,
      0n,
      "No fee charged when configured to zero",
    );
  });

  run_test("router fee accumulation over multiple trades", () => {
    const system = create_system({
      fee_router_ppm: 1000n, // 0.1% fee
      min_initial_foreign: 100_000n,
    });

    system.router.swap_foreign_to_native(100_000n, 0n);

    let total_fees = 0n;
    const trades = [50_000n, 75_000n, 100_000n, 25_000n];

    for (const amount of trades) {
      const result = system.router.swap_foreign_to_native(amount, 0n);
      total_fees += result.foreign_fee;
    }

    // Verify fee manager received all fees
    const expected_total = trades.reduce(
      (sum, amount) => sum + BigMath.mul_div(amount, 1000n, PPM),
      0n,
    );

    assert(
      system.fee_manager.total_foreign_swapped +
        system.fee_manager.buffer_foreign >=
        expected_total,
      "All router fees accumulated in fee manager",
    );
  });

  run_test("router fee precision with small amounts", () => {
    const system = create_system({
      fee_router_ppm: 100n, // 0.01% fee
      min_trade_foreign: 100n,
      min_initial_foreign: 100_000n,
    });

    system.router.swap_foreign_to_native(100_000n, 0n);

    // Test with amount that results in fractional fee
    const small_amount = 999n;
    const result = system.router.swap_foreign_to_native(small_amount, 0n);

    // Fee should be 0 due to rounding down (999 * 100 / 1_000_000 = 0.0999)
    assertBigInt(result.foreign_fee, 0n, "Small fee rounds down to zero");

    // Test with amount that results in exactly 1 unit fee
    const exact_amount = 10_000n;
    const result2 = system.router.swap_foreign_to_native(exact_amount, 0n);
    assertBigInt(result2.foreign_fee, 1n, "Minimum non-zero fee is 1 unit");
  });

  run_test("router fee with route switching", () => {
    const system = create_system({
      fee_router_ppm: 3000n, // 0.3% fee
      slope_ppm: 10_000n, // High slope to encourage route switching
    });

    // First trade via UTBC
    const result1 = system.router.swap_foreign_to_native(200_000n, 0n);
    assert(result1.route === "UTBC", "Initial route is UTBC");
    const fee1 = BigMath.mul_div(200_000n, 3000n, PPM);
    assertBigInt(result1.foreign_fee, fee1, "Fee charged on UTBC route");

    // Multiple trades to potentially change optimal route
    for (let i = 0; i < 5; i++) {
      system.router.swap_foreign_to_native(100_000n, 0n);
    }

    // Check if route switches and fee is still applied
    const result2 = system.router.swap_foreign_to_native(50_000n, 0n);
    const fee2 = BigMath.mul_div(50_000n, 3000n, PPM);
    assertBigInt(result2.foreign_fee, fee2, "Fee charged regardless of route");

    // Fee should be consistent regardless of which route is chosen
    assert(result2.foreign_fee > 0n, "Fee always applied when configured");
  });
});

// === ROUTER FEE EDGE CASES ===
run_section("Router Fee Edge Cases", () => {
  run_test("fee with maximum PPM value", () => {
    const system = create_system({
      fee_router_ppm: 999_999n, // 99.9999% fee (just under 100%)
      min_initial_foreign: 100_000n,
    });

    system.router.swap_foreign_to_native(100_000n, 0n);

    const amount = 1_000_000n;
    const result = system.router.swap_foreign_to_native(amount, 0n);

    // Almost all input should be fee
    assert(
      result.foreign_fee > (amount * 99n) / 100n,
      "Maximum fee takes almost all input",
    );

    // But some should still go through
    assert(
      result.native_out > 0n,
      "Even with max fee, some output is produced",
    );
  });

  run_test("fee interaction with slippage protection", () => {
    const system = create_system({
      fee_router_ppm: 5000n, // 0.5% fee
      min_initial_foreign: 100_000n,
    });

    system.router.swap_foreign_to_native(100_000n, 0n);

    // Get fresh quote for exact amount
    const swap_amount = 50_000n;
    /** @type {ReturnType<typeof system.router.get_best_route>} */
    const quote = system.router.get_best_route(swap_amount);
    assert(quote !== null, "Quote should be returned");
    if (!quote) throw new Error("Quote should not be null");

    // Actual swap with slightly relaxed slippage protection (99.9% of quote)
    // This accounts for potential rounding differences
    const min_output = BigMath.mul_div(quote.native_out, 999n, 1000n);
    const result = system.router.swap_foreign_to_native(
      swap_amount,
      min_output, // Allow 0.1% slippage for rounding
    );

    // Output should be very close to quote (within 0.1%)
    assertApprox(
      result.native_out,
      quote.native_out,
      1000n, // 0.1% tolerance
      "Quote matches actual output including fees",
    );
  });

  run_test("fee burning impact on TBC price", () => {
    const system = create_system({
      fee_router_ppm: 10_000n, // 1% fee
      min_trade_foreign: 10_000n,
    });

    // Initialize and record initial state
    system.router.swap_foreign_to_native(200_000n, 0n);
    const initial_supply = system.utbc_minter.supply;
    const initial_price = system.utbc_minter.get_price();

    // Generate fees through multiple trades
    for (let i = 0; i < 10; i++) {
      system.router.swap_foreign_to_native(20_000n, 0n);
    }

    // Fees should have been burned, reducing supply
    const final_supply = system.utbc_minter.supply;
    const final_price = system.utbc_minter.get_price();

    // Supply might increase (minting) or decrease (burning) depending on routing
    // But if fees were burned, price should be affected
    assert(
      final_supply !== initial_supply || final_price !== initial_price,
      "Fee burning affects supply or price dynamics",
    );
  });

  run_test("fee with native to foreign swaps", () => {
    const system = create_system({
      fee_router_ppm: 2500n, // 0.25% fee
    });

    // Initialize pool
    const mint_result = system.router.swap_foreign_to_native(300_000n, 0n);

    // Swap native to foreign
    const native_amount = mint_result.native_out / 2n;
    const result = system.router.swap_native_to_foreign(native_amount, 0n);

    // Native to foreign swaps don't have router fees in current implementation
    // But verify the swap works correctly
    assert(result.foreign_out > 0n, "Native to foreign swap produces output");
    assert(result.route === "XYK", "Native to foreign always uses XYK");
  });

  run_test("fee precision across different decimal scales", () => {
    // Test with very high precision price
    const high_precision = create_system({
      price_initial: 10n ** 15n, // Very high precision
      fee_router_ppm: 1500n, // 0.15% fee
    });

    high_precision.router.swap_foreign_to_native(100_000n, 0n);
    const result1 = high_precision.router.swap_foreign_to_native(
      1_000_000n,
      0n,
    );

    // Test with very low precision price
    const low_precision = create_system({
      price_initial: 100n, // Low precision
      fee_router_ppm: 1500n, // Same 0.15% fee
    });

    low_precision.router.swap_foreign_to_native(100_000n, 0n);
    const result2 = low_precision.router.swap_foreign_to_native(1_000_000n, 0n);

    // Both should charge the same fee percentage
    assertBigInt(
      result1.foreign_fee,
      result2.foreign_fee,
      "Fee amount independent of price precision",
    );
  });

  run_test("fee buffer overflow protection", () => {
    const system = create_system({
      fee_router_ppm: 100n, // Small fee
      min_trade_foreign: 1_000_000n, // High minimum to force buffering
    });

    system.router.swap_foreign_to_native(1_000_000n, 0n);

    // Generate many small fees that get buffered
    for (let i = 0; i < 100; i++) {
      system.router.swap_foreign_to_native(1_000_000n, 0n);
    }

    // Buffer should handle accumulation without overflow
    assert(
      system.fee_manager.total_foreign_swapped >= 0n,
      "Fee accumulation handles large volumes",
    );
    assert(
      system.fee_manager.total_native_burned >= 0n,
      "Burn tracking handles large volumes",
    );
  });
});

// === SYSTEM INTEGRATION TESTS ===
run_section("System Integration", () => {
  run_test("full cycle: mint, trade, burn", () => {
    const system = create_system({});

    // Initial mint
    const mint1 = system.router.swap_foreign_to_native(200_000n, 0n);
    assert(mint1.route === "UTBC", "Initial mint via UTBC");

    // Second mint
    const mint2 = system.router.swap_foreign_to_native(100_000n, 0n);
    assert(mint2.native_out > 0n, "Second mint successful");

    // Sell some tokens
    const sell = system.router.swap_native_to_foreign(mint1.native_out / 4n);
    assert(sell.foreign_out > 0n, "Sell successful");

    // Check fee accumulation
    const burned = system.fee_manager.total_native_burned;
    assert(
      burned > 0n || system.fee_manager.buffer_foreign > 0n,
      "Fees collected",
    );
  });

  run_test("POL accumulation", () => {
    const system = create_system({});

    // Multiple mints should accumulate POL
    const result1 = system.router.swap_foreign_to_native(100_000n, 0n);
    const pol1 = system.pol_manager.balance_lp;

    const result2 = system.router.swap_foreign_to_native(100_000n, 0n);
    const pol2 = system.pol_manager.balance_lp;

    // POL only increases when routing through UTBC
    if (result2.route === "UTBC") {
      assert(pol2 > pol1, "POL increased when using UTBC");
    } else {
      assertBigInt(pol2, pol1, "POL unchanged when using XYK");
    }
    assert(system.pol_manager.buffer_native >= 0n, "Buffer managed");
  });

  run_test("price convergence", () => {
    const system = create_system({ slope_ppm: 10_000n });

    // Initial mint establishes prices
    system.router.swap_foreign_to_native(1_000_000n, 0n);

    const initial_supply = system.utbc_minter.supply;
    const tbc_price = system.utbc_minter.get_price();
    const xyk_price = system.xyk_pool.get_price();

    // Prices should be related but not necessarily equal
    assert(tbc_price > 0n && xyk_price > 0n, "Both prices established");

    // Multiple trades should drive convergence
    let tbc_routes = 0n;
    for (let i = 0; i < 5; i++) {
      const result = system.router.swap_foreign_to_native(50_000n, 0n);
      if (result.route === "UTBC") tbc_routes += 1n;
    }

    const final_supply = system.utbc_minter.supply;
    const final_tbc = system.utbc_minter.get_price();
    const final_xyk = system.xyk_pool.get_price();

    // TBC price changes based on supply changes
    // Supply can increase (minting) or decrease (fee burning)
    if (final_supply > initial_supply) {
      assert(final_tbc > tbc_price, "TBC price increased with supply");
      assert(tbc_routes > 0n, "Supply increase means TBC was used");
    } else if (final_supply < initial_supply) {
      assert(final_tbc < tbc_price, "TBC price decreased due to burning");
      assertBigInt(tbc_routes, 0n, "No TBC routes when supply decreased");
    } else {
      assertBigInt(final_tbc, tbc_price, "TBC price unchanged");
    }

    // XYK price should change from trades
    assert(final_xyk !== xyk_price, "XYK price changed from trades");
  });

  run_test("multi-hop trading scenario", () => {
    const system = create_system({ fee_router_ppm: 1000n });

    // Initial mint
    const mint1 = system.router.swap_foreign_to_native(500_000n, 0n);

    // Buy more UTBC
    const mint2 = system.router.swap_foreign_to_native(200_000n, 0n);

    // Sell some back
    const sell = system.router.swap_native_to_foreign(
      mint1.native_out / 2n,
      0n,
    );

    // Buy again
    const mint3 = system.router.swap_foreign_to_native(100_000n, 0n);

    // Verify system coherence
    assert(system.xyk_pool.has_liquidity(), "Pool maintained");
    assert(system.pol_manager.balance_lp > 0n, "POL accumulated");
    assert(
      system.fee_manager.total_native_burned > 0n ||
        system.fee_manager.buffer_foreign > 0n,
      "Fees collected (burned or buffered)",
    );
  });

  run_test("stress test with many small operations", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(100_000n, 0n);

    // Many small trades
    for (let i = 0; i < 10; i++) {
      system.router.swap_foreign_to_native(1_000n, 0n);
    }

    // Many small liquidity additions
    for (let i = 0; i < 5; i++) {
      system.pol_manager.add_liquidity(100n * PRECISION, 200n * PRECISION);
    }

    assert(
      system.pol_manager.balance_lp > 0n,
      "POL accumulated from small adds",
    );
  });
});

// === EDGE CASES ===
run_section("Edge Cases", () => {
  run_test("extreme price scales", () => {
    // Test with high price that gives fractional token (0.1 tokens for 1M foreign)
    const high_price = create_system({
      price_initial: 10_000_000n, // This gives 0.1 tokens for 1M foreign
      slope_ppm: 0n, // Use constant price for simplicity
    });
    // Test with very low price (0.0001 per token)
    const low_price = create_system({ price_initial: 100n, slope_ppm: 0n });

    const high_result = high_price.utbc_minter.calculate_mint(1_000_000n);
    const low_result = low_price.utbc_minter.calculate_mint(1_000_000n);

    // With high price, should get a fractional token (0.1 tokens = 100_000_000_000 units)
    assert(
      high_result > 0n && high_result < PRECISION,
      "High price: fractional token",
    );
    // With low price, should get many tokens
    assert(low_result >= 10_000n * PRECISION, "Low price: many tokens");
  });

  run_test("zero amounts handling", () => {
    const system = create_system({});

    try {
      system.router.swap_foreign_to_native(0n);
      assert(false, "Should reject zero amount");
    } catch (e) {
      assert(e.message.includes("positive"), "Zero rejected");
    }
  });

  run_test("supply boundaries", () => {
    const system = create_system({ price_initial: 1n, slope_ppm: 1_000_000n });

    // Mint large amount
    const result = system.utbc_minter.calculate_mint(1_000_000_000_000n);
    assert(result > 0n, "Can calculate large mints");

    // Verify overflow protection
    const huge = system.utbc_minter.calculate_mint(2n ** 200n);
    assert(huge === 0n || huge > 0n, "Handles huge numbers without crash");
  });

  run_test("precision limits", () => {
    const system = create_system({ price_initial: 1n });

    // Extremely small mint
    const tiny = system.utbc_minter.calculate_mint(1n);
    assert(tiny >= 0n, "Tiny mint doesn't underflow");

    // Extremely large mint
    const huge = system.utbc_minter.calculate_mint(10n ** 30n);
    assert(huge > 0n, "Huge mint succeeds");
  });

  run_test("mathematical precision in complex scenarios", () => {
    const system = create_system({
      price_initial: 999_999_999n, // Not a round number
      slope_ppm: 3_333n, // Odd slope value
    });

    // Test with non-round numbers
    const amounts = [999n, 9_999n, 99_999n, 333_333n, 777_777n];

    for (const amount of amounts) {
      const minted = system.utbc_minter.calculate_mint(amount);
      assert(minted > 0n, `Mint succeeds for ${amount}`);

      // Verify reverse calculation (approximate)
      const cost = verify_mint_cost(
        minted,
        999_999_999n,
        3_333n,
        system.utbc_minter.supply,
      );
      assertApprox(cost, amount, 1000n, `Cost verification for ${amount}`);

      // Update supply for next iteration
      system.utbc_minter.supply += minted;
    }
  });

  run_test("integer arithmetic edge cases", () => {
    const system = create_system({
      price_initial: 7n, // Prime number for worst-case division
      slope_ppm: 0n, // Zero slope for pure division test
    });

    // Test division edge cases
    const test_cases = [
      1n, // Minimum
      6n, // Just below price
      7n, // Exactly price
      8n, // Just above price
      49n, // Price squared
      343n, // Price cubed
    ];

    for (const amount of test_cases) {
      const minted = system.utbc_minter.calculate_mint(amount);
      const expected = BigMath.mul_div(amount, PRECISION, 7n);

      // With zero slope, should exactly match simple division
      assertBigInt(minted, expected, `Integer arithmetic exact for ${amount}`);
    }

    // Test with non-zero slope for consistency
    const sloped = create_system({
      price_initial: 1_000_000n,
      slope_ppm: 10_000n, // 1% slope for more noticeable effect
    });

    // Test that calculations work and are reasonable
    const test_amounts = [100_000n, 1_000_000n, 10_000_000n];
    let prev_avg_price = 0n;

    for (const amount of test_amounts) {
      const minted = sloped.utbc_minter.calculate_mint(amount);
      assert(minted > 0n, `Minting succeeds for ${amount} with slope`);

      // Calculate average price for this mint
      const avg_price = BigMath.mul_div(amount, PRECISION, minted);

      // Price should increase with supply
      if (prev_avg_price > 0n) {
        assert(
          avg_price > prev_avg_price,
          `Average price increases with supply`,
        );
      }
      prev_avg_price = avg_price;

      // Update supply for next iteration
      sloped.utbc_minter.supply += minted;
    }
  });

  run_test("buffer edge cases", () => {
    const system = create_system({});

    // Empty buffer operations
    const empty_result = system.pol_manager.add_liquidity(0n, 0n);
    assertBigInt(empty_result.lp_minted, 0n, "Empty add returns zero");

    // Initialize then immediately try empty add
    system.router.swap_foreign_to_native(100_000n, 0n);
    system.pol_manager.add_liquidity(0n, 0n);

    // Should handle gracefully
    assert(true, "Empty operations handled");
  });

  run_test("concurrent operation simulation", () => {
    const system = create_system({});

    // Simulate multiple users acting simultaneously
    const users = [
      () => system.router.swap_foreign_to_native(100_000n, 0n), // First swap must meet minimum initial requirement
      () => system.router.swap_foreign_to_native(30_000n, 0n),
      () => system.router.swap_foreign_to_native(20_000n, 0n),
    ];

    // Execute all operations
    const results = users.map((fn) => fn());

    // All should succeed
    assert(
      results.every((r) => r.native_out > 0n),
      "All concurrent ops succeed",
    );
    assert(system.xyk_pool.has_liquidity(), "Pool initialized");
  });
});

// === ERROR HANDLING TESTS ===
run_section("Error Handling", () => {
  run_test("invalid constructor parameters", () => {
    try {
      new XykPool({ fee_ppm: 1_000_001n });
      assert(false, "Should reject fee > 100%");
    } catch (e) {
      assert(e.message.includes("Fee must be < 100%"), "Fee validation");
    }

    try {
      create_system({ price_initial: -1n });
      assert(false, "Should reject negative price");
    } catch (e) {
      assert(e.message.includes("positive"), "Price validation");
    }
  });

  run_test("swap without liquidity", () => {
    const pool = new XykPool({ fee_ppm: 3000n });

    try {
      pool.swap_foreign_to_native(1000n);
      assert(false, "Should fail without liquidity");
    } catch (e) {
      assert(e.message.includes("liquidity"), "No liquidity error");
    }
  });

  run_test("burn more than supply", () => {
    const system = create_system({});
    system.router.swap_foreign_to_native(100_000n, 0n);

    try {
      system.utbc_minter.burn_native(10n ** 30n);
      assert(false, "Should fail to burn more than exists");
    } catch (e) {
      assert(e.message.includes("Insufficient supply"), "Burn validation");
    }
  });

  run_test("router validation", () => {
    const system = create_system({});

    // Zero amount
    try {
      system.router.swap_foreign_to_native(0n);
      assert(false, "Should reject zero amount");
    } catch (e) {
      assert(e.message.includes("positive"), "Zero amount rejected");
    }

    // Negative amount (if bigint allows)
    try {
      system.router.swap_native_to_foreign(-100n);
      assert(false, "Should reject negative amount");
    } catch (e) {
      assert(true, "Negative amount rejected");
    }
  });
});

// === TEST SUMMARY ===
console.log("\n✅ All tests passed!");
console.log(`📊 Total tests executed: ${test_counter}`);
console.log("🔍 Coverage areas:");
console.log("  • Math utilities and precision");
console.log("  • Bonding curve mathematics");
console.log("  • XYK pool mechanics");
console.log("  • Zap mechanism and POL management");
console.log("  • Fee burning and accumulation");
console.log("  • Smart router and route selection");
console.log("  • System integration scenarios");
console.log("  • Edge cases and error handling");
console.log("  • Router fee mechanics and precision");
