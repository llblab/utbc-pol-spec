// @ts-check

/**
 * @typedef {Object} DistributionShares
 * @property {bigint} user - numerator share for user
 * @property {bigint} pol - numerator share for POL
 * @property {bigint} treasury - numerator share for treasury
 * @property {bigint} team - numerator share for team
 * @property {bigint} den - denominator (sum of shares)
 */

/**
 * @typedef {Object} LpPolicy
 * @property {boolean} withdrawable - true for USER LP, false for POL LP
 */

/**
 * @typedef {Object} ModelConfig
 * @property {bigint} initialPrice - initial price P0 in PRECISION (base/token)
 * @property {bigint} slope - slope s (see getSpotPrice: spot = p0 + floor(s * supply / PRECISION))
 * @property {bigint} xykFee - pool fee in basis points (default 20 = 0.2%)
 * @property {bigint} routerFee - router fee in basis points (default 10 = 0.1%)
 * @property {DistributionShares} [shares] - distribution shares (default: user=3, pol=3, treasury=2, team=1, den=9)
 * @property {LpPolicy} [lpPol] - LP policy for POL (default: withdrawable=false)
 * @property {LpPolicy} [lpUser] - LP policy for User (default: withdrawable=true)
 * @property {bigint} [minBuyTokenOut] - minimum User token output for buys (default 1n)
 * @property {bigint} [minPolTokenOut] - minimum POL token output for protocol adds (default 1n)
 */

/**
 * @typedef {Object} QuoteSwap
 * @property {"UTBC"|"XYK"} route
 * @property {bigint} tokensOut
 * @property {bigint} baseInNet - base amount after router fee
 * @property {bigint} routerFeeTaken - router fee amount (would be taken on success)
 */

/**
 * @typedef {Object} SwapBuyResult
 * @property {boolean} executed - true if main action executed (fee collected only if true)
 * @property {"UTBC"|"XYK"} route
 * @property {bigint} tokensOut
 * @property {bigint} routerFeeTaken
 */

/**
 * @typedef {Object} SwapSellResult
 * @property {boolean} executed
 * @property {bigint} baseOut
 */

/**
 * @typedef {Object} AddLiquidityUserResult
 * @property {boolean} executed - true if liquidity was added (fee collected only if true)
 * @property {bigint} lpMinted
 * @property {bigint} baseUsed
 * @property {bigint} tokenUsed
 * @property {bigint} baseRefund
 * @property {bigint} tokenRefund
 * @property {bigint} routerFeeTaken
 */

/**
 * @typedef {Object} RemoveLiquidityUserResult
 * @property {bigint} baseOut
 * @property {bigint} tokenOut
 */

/**
 * @typedef {Object} PolInfo
 * @property {bigint} lpTotalSupply
 * @property {bigint} polLpBalance
 * @property {bigint} userLpBalance
 * @property {bigint} totalPolTokenContributed
 * @property {bigint} totalPolBaseContributed
 */

/**
 * @typedef {Object} PoolState
 * @property {bigint} tokenReserve
 * @property {bigint} baseReserve
 * @property {bigint} xykFee
 */

/**
 * @typedef {Object} SupplyState
 * @property {bigint} totalSupply
 * @property {bigint} treasuryTokenBalance
 * @property {bigint} teamTokenBalance
 * @property {bigint} burnedTotal
 */

/**
 * @typedef {Object} ConfigView
 * @property {bigint} initialPrice
 * @property {bigint} slope
 * @property {bigint} xykFee
 * @property {bigint} routerFee
 * @property {DistributionShares} shares
 * @property {LpPolicy} lpPol
 * @property {LpPolicy} lpUser
 */

/** Fixed-point constants for Substrate */
export const DECIMALS = 12n;
export const PRECISION = 10n ** DECIMALS;
export const PERCENT = 10000n; // basis points (100% = 10000)

/**
 * mulDiv floor
 * @param {bigint} a
 * @param {bigint} b
 * @param {bigint} den
 * @returns {bigint}
 */
function mulDiv(a, b, den) {
  return (BigInt(a) * BigInt(b)) / BigInt(den);
}

/**
 * Integer sqrt (floor) of non-negative n
 * @param {bigint} n
 * @returns {bigint}
 */
function isqrt(n) {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x0 = n,
    x1 = (n >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + n / x1) >> 1n;
  }
  return x0;
}

/**
 * min
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function min(a, b) {
  return a < b ? a : b;
}

/**
 * Split minted tokens by shares; remainder goes to treasury to conserve total.
 * @param {bigint} minted
 * @param {DistributionShares} shares
 * @returns {{user: bigint, pol: bigint, treasury: bigint, team: bigint}}
 */
function splitMint(minted, shares) {
  const u = (minted * shares.user) / shares.den;
  const p = (minted * shares.pol) / shares.den;
  const tr = (minted * shares.treasury) / shares.den;
  const t = (minted * shares.team) / shares.den;
  const sum = u + p + tr + t;
  const rem = minted - sum;
  return { user: u, pol: p, treasury: tr + rem, team: t };
}

export class UtbcPolModel {
  /** @param {ModelConfig} cfg */
  constructor(cfg) {
    if (!cfg) throw new Error("config required");
    const {
      initialPrice,
      slope,
      xykFee = 20n,
      routerFee = 10n,
      shares,
      lpPol,
      lpUser,
    } = cfg;

    if (initialPrice <= 0n) throw new Error("initialPrice must be > 0");
    if (slope < 0n) throw new Error("slope must be >= 0");
    if (xykFee < 0n || xykFee >= PERCENT) throw new Error("invalid xykFee");
    if (routerFee < 0n || routerFee >= PERCENT)
      throw new Error("invalid routerFee");

    /** @type {DistributionShares} */
    this.shares = shares ?? {
      user: 3n,
      pol: 3n,
      treasury: 2n,
      team: 1n,
      den: 9n,
    };

    // Validate shares distribution to prevent negative treasury
    if (
      this.shares.den <= 0n ||
      this.shares.user < 0n ||
      this.shares.pol < 0n ||
      this.shares.treasury < 0n ||
      this.shares.team < 0n
    ) {
      throw new Error(
        "invalid shares: denominator must be > 0 and all numerators >= 0",
      );
    }

    const sumNumerators =
      this.shares.user +
      this.shares.pol +
      this.shares.treasury +
      this.shares.team;
    if (sumNumerators > this.shares.den) {
      throw new Error(
        "shares sum exceeds denominator: treasury could become negative",
      );
    }

    /** Config */
    this.initialPrice = initialPrice; // base per token (scaled by PRECISION)
    this.slope = slope; // used as: spot = p0 + floor(s * S / PRECISION)
    this.xykFee = xykFee;
    this.routerFee = routerFee;

    /** LP policies */
    /** @type {LpPolicy} */
    this.lpPol = lpPol ?? { withdrawable: false };
    /** @type {LpPolicy} */
    this.lpUser = lpUser ?? { withdrawable: true };
    this.minInitialLiquidity = 1n;

    /** Supply and balances */
    this.totalSupply = 0n;
    this.treasuryTokenBalance = 0n;
    this.teamTokenBalance = 0n;
    this.burnedTotal = 0n;

    /** XYK reserves */
    this.tokenReserve = 0n;
    this.baseReserve = 0n;

    /** LP token accounting */
    this.lpTotalSupply = 0n;
    this.polLpBalance = 0n;
    this.userLpBalance = 0n;

    /** POL contributions (audit) */
    this.totalPolTokenContributed = 0n;
    this.totalPolBaseContributed = 0n;

    /** Router buyback base buffer */
    this.buybackBaseBuffer = 0n;

    /** Total tokens burned via buybacks */
    this.totalBuybackBurned = 0n;

    /** Minimum outputs */
    this.minBuyTokenOut = cfg.minBuyTokenOut ?? 1n;
    this.minPolTokenOut = cfg.minPolTokenOut ?? 1n;
  }

  /** @returns {ConfigView} */
  getConfig() {
    return {
      initialPrice: this.initialPrice,
      slope: this.slope,
      xykFee: this.xykFee,
      routerFee: this.routerFee,
      shares: this.shares,
      lpPol: this.lpPol,
      lpUser: this.lpUser,
    };
  }

  /** @returns {PoolState} */
  getPoolState() {
    return {
      tokenReserve: this.tokenReserve,
      baseReserve: this.baseReserve,
      xykFee: this.xykFee,
    };
  }

  /** @returns {SupplyState} */
  getSupplyState() {
    return {
      totalSupply: this.totalSupply,
      treasuryTokenBalance: this.treasuryTokenBalance,
      teamTokenBalance: this.teamTokenBalance,
      burnedTotal: this.burnedTotal,
    };
  }

  /** @returns {PolInfo} */
  getPolInfo() {
    return {
      lpTotalSupply: this.lpTotalSupply,
      polLpBalance: this.polLpBalance,
      userLpBalance: this.userLpBalance,
      totalPolTokenContributed: this.totalPolTokenContributed,
      totalPolBaseContributed: this.totalPolBaseContributed,
    };
  }

  /**
   * Current spot price of token in terms of base (base per token, scaled by PRECISION).
   * spot = p0 + floor(s * supply / PRECISION).
   * @returns {bigint}
   */
  getSpotPrice() {
    const inc =
      this.slope === 0n ? 0n : (this.slope * this.totalSupply) / PRECISION;
    return this.initialPrice + inc;
  }

  /**
   * XYK price (base per token, scaled), if pool exists; else 0.
   * @returns {bigint}
   */
  getXYKPriceBasePerToken() {
    if (this.tokenReserve === 0n || this.baseReserve === 0n) return 0n;
    return mulDiv(this.baseReserve, PRECISION, this.tokenReserve);
  }

  /**
   * Compute tokens minted for given base reserve (net) via UTBC.
   * Correct under scaling:
   * R = (spot/P)*ΔS + (s/(2 P^2))*ΔS^2  => ΔS = P*(sqrt(spot^2 + 2*s*R) - spot)/s
   * @param {bigint} reserveNet
   * @returns {bigint} mintedGross
   */
  mintedFromReserve(reserveNet) {
    if (reserveNet <= 0n) return 0n;
    const spot = this.getSpotPrice(); // scaled by PRECISION
    if (this.slope === 0n) {
      return (reserveNet * PRECISION) / spot;
    }
    const inner = spot * spot + 2n * this.slope * reserveNet; // PRECISION outside sqrt
    const root = isqrt(inner);
    if (root <= spot) return 0n;
    return ((root - spot) * PRECISION) / this.slope;
  }

  /** @param {bigint} baseGross @returns {{net: bigint, fee: bigint}} */
  _takeRouterFeePreview(baseGross) {
    if (baseGross <= 0n) return { net: 0n, fee: 0n };
    const fee = mulDiv(baseGross, this.routerFee, PERCENT);
    const net = baseGross - fee;
    return { net, fee };
  }

  /** @param {bigint} baseGross @returns {{net: bigint, fee: bigint}} */
  _takeRouterFee(baseGross) {
    const { net, fee } = this._takeRouterFeePreview(baseGross);
    if (fee > 0n) this.buybackBaseBuffer += fee;
    return { net, fee };
  }

  /**
   * Quote UTBC (user receive portion only), for baseGross that will be charged with router fee.
   * NOTE: This is a raw quote that may not be executable due to bootstrap requirements or minimum output thresholds.
   * @param {bigint} baseGross
   * @returns {QuoteSwap}
   */
  quoteUTBC(baseGross) {
    const { net, fee } = this._takeRouterFeePreview(baseGross);
    const minted = this.mintedFromReserve(net);
    const parts = splitMint(minted, this.shares);

    // Check basic viability constraints
    if (
      minted <= 0n ||
      parts.user < this.minBuyTokenOut ||
      parts.pol < this.minPolTokenOut
    ) {
      return {
        route: "UTBC",
        tokensOut: 0n,
        baseInNet: net,
        routerFeeTaken: fee,
      };
    }

    // Check bootstrap viability if pool missing
    if (this.tokenReserve === 0n || this.baseReserve === 0n) {
      const lpPotential = isqrt(parts.pol * net);
      if (lpPotential < this.minInitialLiquidity) {
        return {
          route: "UTBC",
          tokensOut: 0n,
          baseInNet: net,
          routerFeeTaken: fee,
        };
      }
    }

    return {
      route: "UTBC",
      tokensOut: parts.user,
      baseInNet: net,
      routerFeeTaken: fee,
    };
  }

  /**
   * Quote XYK swap for baseGross (after router fee).
   * @param {bigint} baseGross
   * @returns {QuoteSwap}
   */
  quoteXYK(baseGross) {
    const { net, fee } = this._takeRouterFeePreview(baseGross);
    const out = this._xykQuoteTokensOutForBaseIn(net);
    return {
      route: "XYK",
      tokensOut: out,
      baseInNet: net,
      routerFeeTaken: fee,
    };
  }

  /**
   * Router decision by tokensOut (UTBC preference on ties).
   * @param {bigint} baseGross
   * @returns {QuoteSwap}
   */
  routeQuote(baseGross) {
    const utbc = this.quoteUTBC(baseGross);
    const xyk = this.quoteXYK(baseGross);
    return utbc.tokensOut >= xyk.tokensOut ? utbc : xyk;
  }

  /**
   * Get total POL (protocol-owned liquidity) value in base units:
   * valueInBase = 2 * (polLp / L) * baseReserve
   * @returns {{lpTokens: bigint, lpValue: bigint, tokenContributed: bigint, baseContributed: bigint}}
   */
  totalPOL() {
    const L = this.lpTotalSupply;
    const pol = this.polLpBalance;
    const baseShare = L > 0n ? mulDiv(pol, this.baseReserve, L) : 0n;
    const valueInBase = baseShare * 2n;
    return {
      lpTokens: pol,
      lpValue: valueInBase,
      tokenContributed: this.totalPolTokenContributed,
      baseContributed: this.totalPolBaseContributed,
    };
  }

  /** Get cumulative buyback burned amount */
  cumulativeBuybackBurned() {
    return this.totalBuybackBurned;
  }

  /**
   * Swap exact tokens -> base via XYK (no UTBC redemption path)
   * No router fee on sells.
   * @param {bigint} tokenAmount
   * @param {bigint} minBaseOut
   * @returns {SwapSellResult}
   */
  swapExactTokensForBase(tokenAmount, minBaseOut) {
    if (tokenAmount <= 0n) return { executed: false, baseOut: 0n };

    const baseOutQuote = this._xykQuoteBaseOutForTokenIn(tokenAmount);
    if (baseOutQuote < minBaseOut) return { executed: false, baseOut: 0n };

    const actualOut = this._executeXYKSellSwap(tokenAmount);
    if (actualOut < minBaseOut)
      throw new Error("XYK sell swap output below minimum after execution");

    this._tryBuyback();
    return { executed: true, baseOut: actualOut };
  }

  /**
   * Swap base -> token optimally (UTBC or XYK).
   * Fee collected only on success; buy&burn performed if pool exists.
   * Attempts fallback to XYK if UTBC execution is not viable.
   * @param {bigint} baseGross
   * @param {bigint} minTokensOut
   * @returns {SwapBuyResult}
   */
  swapExactBaseForTokens(baseGross, minTokensOut) {
    if (baseGross <= 0n) {
      return {
        executed: false,
        route: "XYK",
        tokensOut: 0n,
        routerFeeTaken: 0n,
      };
    }

    const { net, fee } = this._takeRouterFeePreview(baseGross);

    const utbcMinted = this.mintedFromReserve(net);
    const parts = splitMint(utbcMinted, this.shares);
    const utbcUser = parts.user;
    const xykOut = this._xykQuoteTokensOutForBaseIn(net);

    // Check UTBC bootstrap viability if pool missing (threshold-only)
    let utbcBootstrapViable = true;
    if (this.tokenReserve === 0n || this.baseReserve === 0n) {
      const lpPotential = isqrt(parts.pol * net);
      utbcBootstrapViable = lpPotential >= this.minInitialLiquidity;
    }

    const utbcViable =
      utbcMinted > 0n &&
      utbcUser >= this.minBuyTokenOut &&
      parts.pol >= this.minPolTokenOut &&
      utbcBootstrapViable;

    // Pick route by quoted tokensOut, but only if UTBC is viable
    let route = /** @type {"UTBC"|"XYK"} */ ("XYK");
    if (utbcViable && utbcUser >= xykOut) route = "UTBC";

    const tokensOutQuoted = route === "UTBC" ? utbcUser : xykOut;
    if (tokensOutQuoted < minTokensOut) {
      return { executed: false, route, tokensOut: 0n, routerFeeTaken: 0n };
    }

    let actualOut = 0n;
    if (route === "UTBC") {
      actualOut = this._executeMintAndPolAdd(net);
      // If UTBC failed at execution time, try fallback XYK if it meets minTokensOut
      if (actualOut === 0n && xykOut >= minTokensOut && xykOut > 0n) {
        route = "XYK";
        actualOut = this._executeXYKSwap(net);
      }
      if (actualOut === 0n) {
        return {
          executed: false,
          route: "UTBC",
          tokensOut: 0n,
          routerFeeTaken: 0n,
        };
      }
    } else {
      actualOut = this._executeXYKSwap(net);
      if (actualOut < minTokensOut) {
        return { executed: false, route, tokensOut: 0n, routerFeeTaken: 0n };
      }
    }

    // Take router fee only after success
    this._takeRouterFee(baseGross);

    if (actualOut < minTokensOut)
      throw new Error("Actual output below minimum after execution");

    this._tryBuyback();

    return { executed: true, route, tokensOut: actualOut, routerFeeTaken: fee };
  }

  /**
   * User adds liquidity. Fee collected only on success; unused amounts refunded.
   * Prevents User from bootstrapping pool (must be done via UTBC first).
   * @param {bigint} baseGross
   * @param {bigint} tokenAmount
   * @param {bigint} minLpOut
   * @returns {AddLiquidityUserResult}
   */
  addLiquidityUser(baseGross, tokenAmount, minLpOut) {
    if (this.tokenReserve === 0n || this.baseReserve === 0n) {
      return {
        executed: false,
        lpMinted: 0n,
        baseUsed: 0n,
        tokenUsed: 0n,
        baseRefund: baseGross,
        tokenRefund: tokenAmount,
        routerFeeTaken: 0n,
      };
    }

    if (baseGross <= 0n || tokenAmount <= 0n) {
      return {
        executed: false,
        lpMinted: 0n,
        baseUsed: 0n,
        tokenUsed: 0n,
        baseRefund: baseGross,
        tokenRefund: tokenAmount,
        routerFeeTaken: 0n,
      };
    }

    const X = this.tokenReserve;
    const Y = this.baseReserve;

    // Calculate what we can get after router fee from full baseGross
    const { net: maxBaseNet } = this._takeRouterFeePreview(baseGross);

    // Calculate token requirement for this net base amount
    const tokenRequiredForMaxBase = mulDiv(maxBaseNet, X, Y);

    let useBaseNet = 0n;
    let useToken = 0n;
    let useBaseGross = 0n;

    if (tokenAmount >= tokenRequiredForMaxBase) {
      // Token amount is sufficient, base is limiting factor
      useBaseNet = maxBaseNet;
      useToken = tokenRequiredForMaxBase;
      useBaseGross = baseGross;
    } else {
      // Token amount is limiting factor
      useToken = tokenAmount;
      // Calculate required net base for these tokens
      const baseNetNeeded = mulDiv(tokenAmount, Y, X);
      // Convert net base to gross base (reverse router fee calculation)
      useBaseGross = mulDiv(baseNetNeeded, PERCENT, PERCENT - this.routerFee);
      // Cap at available amount
      if (useBaseGross > baseGross) {
        useBaseGross = baseGross;
      }
      // Recalculate actual net from capped gross
      const { net } = this._takeRouterFeePreview(useBaseGross);
      useBaseNet = net;
      // Recalculate token amount for actual net base
      useToken = mulDiv(useBaseNet, X, Y);
      if (useToken > tokenAmount) {
        useToken = tokenAmount;
      }
    }

    if (useBaseNet <= 0n || useToken <= 0n) {
      return {
        executed: false,
        lpMinted: 0n,
        baseUsed: 0n,
        tokenUsed: 0n,
        baseRefund: baseGross,
        tokenRefund: tokenAmount,
        routerFeeTaken: 0n,
      };
    }

    const L = this.lpTotalSupply;
    const lpMinted = min(mulDiv(useToken, L, X), mulDiv(useBaseNet, L, Y));

    if (lpMinted < minLpOut || lpMinted === 0n) {
      return {
        executed: false,
        lpMinted: 0n,
        baseUsed: 0n,
        tokenUsed: 0n,
        baseRefund: baseGross,
        tokenRefund: tokenAmount,
        routerFeeTaken: 0n,
      };
    }

    // Take router fee only on success and only from used amount
    const { fee } = this._takeRouterFee(useBaseGross);

    this.baseReserve += useBaseNet;
    this.tokenReserve += useToken;
    this.lpTotalSupply += lpMinted;
    this.userLpBalance += lpMinted;

    this._tryBuyback();

    return {
      executed: true,
      lpMinted,
      baseUsed: useBaseNet,
      tokenUsed: useToken,
      baseRefund: baseGross - useBaseGross,
      tokenRefund: tokenAmount - useToken,
      routerFeeTaken: fee,
    };
  }

  /** @param {bigint} lpAmount @param {bigint} minBaseOut @param {bigint} minTokenOut */
  removeLiquidityUser(lpAmount, minBaseOut, minTokenOut) {
    if (!this.lpUser.withdrawable) {
      throw new Error("user LP is non-withdrawable by policy");
    }
    if (lpAmount <= 0n) return { baseOut: 0n, tokenOut: 0n };
    if (lpAmount > this.userLpBalance) throw new Error("insufficient User LP");

    const L = this.lpTotalSupply;
    if (L === 0n) throw new Error("no LP supply");

    const baseOut = mulDiv(this.baseReserve, lpAmount, L);
    const tokenOut = mulDiv(this.tokenReserve, lpAmount, L);

    if (baseOut < minBaseOut || tokenOut < minTokenOut)
      throw new Error("slippage on remove");

    this.baseReserve -= baseOut;
    this.tokenReserve -= tokenOut;
    this.lpTotalSupply -= lpAmount;
    this.userLpBalance -= lpAmount;

    return { baseOut, tokenOut };
  }

  /**
   * Try to execute buyback using buybackBaseBuffer if pool exists.
   * Buys tokens for base fee and burns them (reduce totalSupply).
   */
  _tryBuyback() {
    if (this.tokenReserve === 0n || this.baseReserve === 0n) return;
    const feeAmount = this.buybackBaseBuffer;
    if (feeAmount <= 0n) return;

    const tokensOut = this._xykQuoteTokensOutForBaseIn(feeAmount);
    if (tokensOut <= 0n) return;

    this.baseReserve += feeAmount;
    this.tokenReserve -= tokensOut;
    this.buybackBaseBuffer = 0n;

    const burn = min(tokensOut, this.totalSupply);
    this.totalSupply -= burn;
    this.totalBuybackBurned += burn;
    this.burnedTotal += burn;
  }

  /**
   * XYK quote: tokens out for base in (net), considering pool fee.
   * @param {bigint} baseIn
   * @returns {bigint}
   */
  _xykQuoteTokensOutForBaseIn(baseIn) {
    return this._xykQuoteTokensOutForBaseInGiven(
      this.tokenReserve,
      this.baseReserve,
      baseIn,
    );
  }

  /**
   * XYK quote: base out for token in (net), considering pool fee.
   * @param {bigint} tokenIn
   * @returns {bigint}
   */
  _xykQuoteBaseOutForTokenIn(tokenIn) {
    return this._xykQuoteBaseOutForTokenInGiven(
      this.tokenReserve,
      this.baseReserve,
      tokenIn,
    );
  }

  /**
   * @param {bigint} X
   * @param {bigint} Y
   * @param {bigint} baseIn
   * @returns {bigint}
   */
  _xykQuoteTokensOutForBaseInGiven(X, Y, baseIn) {
    if (baseIn <= 0n || X === 0n || Y === 0n) return 0n;
    const inWithFee = mulDiv(baseIn, PERCENT - this.xykFee, PERCENT);
    const numerator = X * inWithFee;
    const denominator = Y + inWithFee;
    return denominator === 0n ? 0n : numerator / denominator;
  }

  /**
   * @param {bigint} X
   * @param {bigint} Y
   * @param {bigint} tokenIn
   * @returns {bigint}
   */
  _xykQuoteBaseOutForTokenInGiven(X, Y, tokenIn) {
    if (tokenIn <= 0n || X === 0n || Y === 0n) return 0n;
    const inWithFee = mulDiv(tokenIn, PERCENT - this.xykFee, PERCENT);
    const numerator = Y * inWithFee;
    const denominator = X + inWithFee;
    return denominator === 0n ? 0n : numerator / denominator;
  }

  /**
   * Execute mint with UTBC and add POL liquidity atomically.
   * - If pool missing: bootstrap only
   * - Else: internal zap to maximize LP minted without donation.
   * Returns User tokens (user share of minted) or 0 on failure.
   * @param {bigint} baseNet
   * @returns {bigint} userTokensOut
   */
  _executeMintAndPolAdd(baseNet) {
    if (baseNet <= 0n) return 0n;

    const minted = this.mintedFromReserve(baseNet);
    if (minted <= 0n) return 0n;

    const parts = splitMint(minted, this.shares);
    if (parts.user < this.minBuyTokenOut || parts.pol < this.minPolTokenOut)
      return 0n;

    // Bootstrap
    if (this.tokenReserve === 0n || this.baseReserve === 0n) {
      const lpPotential = isqrt(parts.pol * baseNet);
      if (lpPotential < this.minInitialLiquidity) return 0n;

      // Commit mint
      this.totalSupply += minted;
      this.treasuryTokenBalance += parts.treasury;
      this.teamTokenBalance += parts.team;

      // Deposit both sides fully; mint LP to POL (no zero-address locking)
      this.tokenReserve += parts.pol;
      this.baseReserve += baseNet;
      this.lpTotalSupply += lpPotential;
      this.polLpBalance += lpPotential;

      this.totalPolTokenContributed += parts.pol;
      this.totalPolBaseContributed += baseNet;

      return parts.user;
    }

    // Existing pool: pre-check LP viability to ensure atomicity
    // Calculate what LP would be minted to avoid state corruption
    const X0 = this.tokenReserve;
    const Y0 = this.baseReserve;
    const T1 = parts.pol;
    const B1 = baseNet;

    // Pre-calculate minimum LP that would be obtained
    let minLpPotential = 0n;
    if (T1 * Y0 === B1 * X0) {
      // Perfect ratio case
      const L = this.lpTotalSupply;
      minLpPotential = min(mulDiv(T1, L, X0), mulDiv(B1, L, Y0));
    } else {
      // Complex zap case - estimate minimum LP conservatively
      // This is a simplified check to prevent zero LP scenarios
      const L = this.lpTotalSupply;
      const directLpFromToken = mulDiv(T1, L, X0);
      const directLpFromBase = mulDiv(B1, L, Y0);
      minLpPotential = min(directLpFromToken, directLpFromBase) / 2n; // Conservative estimate
    }

    if (minLpPotential === 0n) return 0n;

    // Nowhen zap+deposit POL
    this.totalSupply += minted;
    this.treasuryTokenBalance += parts.treasury;
    this.teamTokenBalance += parts.team;

    this._addLiquidityPOLAtomic(parts.pol, baseNet);
    return parts.user;
  }

  /**
   * Execute XYK swap: base in, tokens out.
   * @param {bigint} baseNet
   * @returns {bigint}
   */
  _executeXYKSwap(baseNet) {
    if (baseNet <= 0n) return 0n;
    const out = this._xykQuoteTokensOutForBaseIn(baseNet);
    if (out <= 0n) return 0n;
    this.baseReserve += baseNet;
    this.tokenReserve -= out;
    return out;
  }

  /**
   * Execute XYK swap: tokens in, base out.
   * @param {bigint} tokenNet
   * @returns {bigint}
   */
  _executeXYKSellSwap(tokenNet) {
    if (tokenNet <= 0n) return 0n;
    const out = this._xykQuoteBaseOutForTokenIn(tokenNet);
    if (out <= 0n) return 0n;
    this.tokenReserve += tokenNet;
    this.baseReserve -= out;
    return out;
  }

  /**
   * Atomic add of POL liquidity with a single internal swap (zap).
   * Assumes pool exists. Deposits full polTokenAmount (T1) and baseAmount (B1).
   * Maximizes LP minted by approximately equalizing dX/X' and dY/Y'.
   * @param {bigint} polTokenAmount - T1
   * @param {bigint} baseAmount - B1
   */
  _addLiquidityPOLAtomic(polTokenAmount, baseAmount) {
    if (polTokenAmount < 0n || baseAmount < 0n)
      throw new Error("negative POL add");
    if (polTokenAmount === 0n && baseAmount === 0n) return;
    if (this.tokenReserve === 0n || this.baseReserve === 0n)
      throw new Error("zap requires existing pool");

    const X0 = this.tokenReserve;
    const Y0 = this.baseReserve;
    const T1 = polTokenAmount;
    const B1 = baseAmount;

    // If ratio matches, deposit directly
    if (T1 * Y0 === B1 * X0) {
      this._mintAndDepositLp(T1, B1, X0, Y0, true);
      this.totalPolTokenContributed += T1;
      this.totalPolBaseContributed += B1;
      return;
    }

    // Helpers
    const gBaseIn = /** @param {bigint} y */ (y) => {
      const tOut = this._xykQuoteTokensOutForBaseInGiven(X0, Y0, y);
      const Xp = X0 - tOut;
      const Yp = Y0 + y;
      const dX = T1 + tOut;
      const dY = B1 - y;
      return dX * Yp - dY * Xp;
    };
    const gTokenIn = /** @param {bigint} x */ (x) => {
      const bOut = this._xykQuoteBaseOutForTokenInGiven(X0, Y0, x);
      const Xp = X0 + x;
      const Yp = Y0 - bOut;
      const dX = T1 - x;
      const dY = B1 + bOut;
      return dX * Yp - dY * Xp;
    };

    if (T1 * Y0 < B1 * X0) {
      // Base-heavy: swap base-in y ∈ [0, B1]
      let lo = 0n,
        hi = B1;
      let gLo = gBaseIn(lo);
      if (gLo >= 0n) {
        this._mintAndDepositLp(T1, B1, X0, Y0, true);
        this.totalPolTokenContributed += T1;
        this.totalPolBaseContributed += B1;
        return;
      }
      for (let i = 0; i < 32 && lo + 1n < hi; i++) {
        const mid = (lo + hi) >> 1n;
        const gm = gBaseIn(mid);
        if (gm < 0n) {
          lo = mid;
          gLo = gm;
        } else {
          hi = mid;
        }
      }
      const pick = /** @param {bigint} y */ (y) => {
        const tOut = this._xykQuoteTokensOutForBaseInGiven(X0, Y0, y);
        const Xp = X0 - tOut;
        const Yp = Y0 + y;
        const dX = T1 + tOut;
        const dY = B1 - y;
        const L = this.lpTotalSupply;
        const lp = min(
          Xp === 0n ? 0n : mulDiv(dX, L, Xp),
          Yp === 0n ? 0n : mulDiv(dY, L, Yp),
        );
        return { y, tOut, Xp, Yp, dX, dY, lp };
      };
      const a = pick(lo),
        b = pick(hi);
      const best = b.lp >= a.lp ? b : a;

      this._mintAndDepositLp(best.dX, best.dY, best.Xp, best.Yp, true);
      this.totalPolTokenContributed += T1;
      this.totalPolBaseContributed += B1;
    } else {
      // Token-heavy: swap token-in x ∈ [0, T1]
      let lo = 0n,
        hi = T1;
      let gLo = gTokenIn(lo);
      if (gLo <= 0n) {
        this._mintAndDepositLp(T1, B1, X0, Y0, true);
        this.totalPolTokenContributed += T1;
        this.totalPolBaseContributed += B1;
        return;
      }
      for (let i = 0; i < 32 && lo + 1n < hi; i++) {
        const mid = (lo + hi) >> 1n;
        const gm = gTokenIn(mid);
        if (gm > 0n) {
          lo = mid;
          gLo = gm;
        } else {
          hi = mid;
        }
      }
      const pick = /** @param {bigint} x */ (x) => {
        const bOut = this._xykQuoteBaseOutForTokenInGiven(X0, Y0, x);
        const Xp = X0 + x;
        const Yp = Y0 - bOut;
        const dX = T1 - x;
        const dY = B1 + bOut;
        const L = this.lpTotalSupply;
        const lp = min(
          Xp === 0n ? 0n : mulDiv(dX, L, Xp),
          Yp === 0n ? 0n : mulDiv(dY, L, Yp),
        );
        return { x, bOut, Xp, Yp, dX, dY, lp };
      };
      const a = pick(lo),
        b = pick(hi);
      const best = b.lp >= a.lp ? b : a;

      this._mintAndDepositLp(best.dX, best.dY, best.Xp, best.Yp, true);
      this.totalPolTokenContributed += T1;
      this.totalPolBaseContributed += B1;
    }
  }

  /**
   * Mint LP for deposit (dX, dY) into pool with pre-deposit reserves (X, Y).
   * Updates reserves, total LP, and credit to POL or USER.
   * Pool must exist (L>0, X>0, Y>0).
   * @param {bigint} dX - token amount to deposit
   * @param {bigint} dY - base amount to deposit
   * @param {bigint} X - pre-deposit token reserve
   * @param {bigint} Y - pre-deposit base reserve
   * @param {boolean} creditToPOL - true for POL, false for USER
   */
  _mintAndDepositLp(dX, dY, X, Y, creditToPOL) {
    if (dX < 0n || dY < 0n) throw new Error("negative deposit");
    if (dX === 0n && dY === 0n) return;
    if (this.lpTotalSupply === 0n || X === 0n || Y === 0n) {
      throw new Error("mintAndDepositLp requires existing pool");
    }

    const L = this.lpTotalSupply;
    const lpByX = mulDiv(dX, L, X);
    const lpByY = mulDiv(dY, L, Y);
    const lpMinted = min(lpByX, lpByY);

    // Prevent donation when no LP tokens would be minted
    if (lpMinted === 0n) {
      throw new Error("LP deposit too small: would result in zero LP tokens");
    }

    this.tokenReserve = X + dX;
    this.baseReserve = Y + dY;
    this.lpTotalSupply = L + lpMinted;

    if (creditToPOL) this.polLpBalance += lpMinted;
    else this.userLpBalance += lpMinted;
  }
}

export default UtbcPolModel;
