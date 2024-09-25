const ethers = require("ethers");
const PARAMS = require("../params.json");
const pair_abi = require("../abi/UniswapV2Pair.json");
const {
  compareAddress,
  ERC20_ABI,
  UNISWAPV2_FACTORY_ABI,
  BLACKLIST_DECODER,
  BLACKLIST_SELECTORS,
  PINKSALE_FINALIZE_METHOD_ID,
} = require("./utils");
const {
  liquidityAddDetect,
  listingIDDetect,
  pinksaleDetect,
  dxSaleDetect,
} = require("./listingDetectors");
const { getRandomNumber } = require('./utils')
const { swapForTokenDetect } = require("./followActionDetectors");
// NOTE: Pass address arguments in lower case only, this restriction is applied
// to reduce operations required while checingk transactions

let uniswapV2Factory = undefined;
let storedGain;

let _lastGainTx, highestPrice;

// Use Random RealBuyGas
const randsRealBuyGas = PARAMS.randomRealBuyGas
const randomRealBuyGas = getRandomNumber(randsRealBuyGas[0], randsRealBuyGas[1]).toFixed(0)

// Use Random PriorityGas
const randsPriorityGas = PARAMS.randomPriorityGas
const randomPriorityGas = getRandomNumber(randsPriorityGas[0], randsPriorityGas[1]).toFixed(0)



const getTransactionMetadata = (transaction, maxGasParams) => {
  let out = {
    valid: false,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    gasPrice: null,
    IS_EIP1559: false,
  };

  if (!transaction.to) return out;
  out.hash = transaction.hash;

  if (transaction.maxFeePerGas) out.IS_EIP1559 = true;
  if (out.IS_EIP1559) {
    if (maxGasParams && (transaction.maxFeePerGas >= maxGasParams.maxFeePerGas))
      return out;
    out.maxFeePerGas = transaction.maxFeePerGas;
    out.maxPriorityFeePerGas = transaction.maxPriorityFeePerGas;
  } else {
    if (maxGasParams && (transaction.maxFeePerGas >= maxGasParams.maxFeePerGas))
      return out;
    out.gasPrice = transaction.gasPrice;
  }

  out.valid = true;
  return out;
};

// Checks transaction and returns `out` consisting of all necessary params
const checkLiquidityAddTx = async (transaction, args) => {
  const {
    ABI_SYMB,
    uniswapV2R2Decoder,
    wethAddress,
    routerAddress,
    purchaseTokenAddress,
    liquidityTokenAddress,
    minimumLiquidity,
  } = args;

  let out = {
    ...getTransactionMetadata(transaction),
    liquidityToken: null,
  };
  if (!out.valid) return null;

  let decoded;
  try {
    decoded = uniswapV2R2Decoder.decodeData(transaction.data);
  } catch (e) {
    return null;
  }
  if (!compareAddress(transaction.to, routerAddress)) return null;

  let inputs = decoded.inputs;
  if (decoded.method === `addLiquidity${ABI_SYMB}`) {
    inputs[3] = ethers.toBigInt(inputs[3].toString());

    if (inputs[3].lt(minimumLiquidity)) return null;
    if (compareAddress(inputs[0], purchaseTokenAddress)) {
      out.liquidityToken = wethAddress;
    } else return null;
    if (
      liquidityTokenAddress &&
      !compareAddress(liquidityTokenAddress, out.liquidityToken)
    ) {
      return null;
    }
    return out;
  } else if (decoded.method === "addLiquidity") {
    inputs[4] = ethers.toBigInt(inputs[4].toString());
    inputs[5] = ethers.toBigInt(inputs[5].toString());
    if (compareAddress(inputs[0], purchaseTokenAddress)) {
      if (inputs[5].lt(minimumLiquidity)) return null;
      out.liquidityToken = inputs[1];
    } else if (compareAddress(inputs[1], purchaseTokenAddress)) {
      if (inputs[4].lt(minimumLiquidity)) return null;
      out.liquidityToken = inputs[0];
    } else return null;
    if (
      liquidityTokenAddress &&
      !compareAddress(liquidityTokenAddress, out.liquidityToken)
    ) {
      return null;
    }
    return out;
  }
  return null;
};

// Checks transaction and returns `out` consisting of all necessary params
const checkRugPullTx = async (transaction, args) => {
  const {
    walletAddress,
    ABI_SYMB,
    uniswapV2R2Decoder,
    wethAddress,
    routerAddress,
    purchaseTokenAddress,
    liquidityTokenAddress,
    devWalletAddress,
    toxicIds,
    Log,
    nonToxicIds,
    gasMultiplier,
    router,
    provider
  } = args;

  if (!uniswapV2Factory) {
    uniswapV2Factory = new ethers.Contract(
      await router.factory(),
      UNISWAPV2_FACTORY_ABI,
      provider
    );
  }

  let out = getTransactionMetadata(transaction);
  if (!out.valid) return null;
  out = { ...out, liquidityToken: null, rugPull: null };

  // Use gas multiplier
  if (out.IS_EIP1559) {

    out.maxFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxFeePerGas) * gasMultiplier)
    );

    out.maxPriorityFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxPriorityFeePerGas) * gasMultiplier)
    );
  }
  else
    out.gasPrice = ethers.toBigInt(
      Math.ceil(Number(transaction.gasPrice) * gasMultiplier)
    );

  out.rugPull = true;

  if (!devWalletAddress) return;
  let fromDevWallet = compareAddress(transaction.from, devWalletAddress);

  if (fromDevWallet ||
    (purchaseTokenAddress && compareAddress(transaction.to, purchaseTokenAddress)))
    if (checkBlaclist(transaction, walletAddress, nonToxicIds)) {
      Log("Blacklist!!!");
      return out;
    }

  if (!fromDevWallet) return null;

  let fwOut = checkFollowWalletSell(transaction, {
    ...args,
    followed: null,
    purchaseTokenBalance: args.purchaseTokenBalance * args.balanceCheckMultiplier,
    externalCheck: true,
  });

  // TOXIC IDS CHECKS
  let id = transaction.data.slice(0, 10);
  if (toxicIds != null) {
    if (toxicIds.length == 0 && !nonToxicIds.includes(id)) toxicIds.push(id);
    if (toxicIds.includes(id) && transaction.to) {
      Log("Toxid ID!!!");
      return out;
    }
  }

  let decoded;
  try {
    decoded = uniswapV2R2Decoder.decodeData(transaction.data);
  } catch (e) {
    return null;
  }
  console.log(decoded.method, "method");
  if (!compareAddress(transaction.to, routerAddress)) return null;
  let inputs = decoded.inputs;
  if (
    decoded.method === `removeLiquidity${ABI_SYMB}` ||
    decoded.method == `removeLiquidity${ABI_SYMB}WithPermit`
  ) {

    out.liquidityToken = wethAddress;
    if (!compareAddress(inputs[0], purchaseTokenAddress)) {
      return null;
    }
    if (!compareAddress(liquidityTokenAddress, out.liquidityToken)) {
      return null;
    }
    Log("Liquidity pull!!! Type with ETH Conversion");
    const pairAddress = await uniswapV2Factory.getPair(
      purchaseTokenAddress,
      out.liquidityToken
    );
    const Pair_Contract = new ethers.Contract(pairAddress, pair_abi.abi, provider);
    var total_supply_hex = await Pair_Contract.totalSupply();
    var total_supply = Number(total_supply_hex.toString());
    var remove_liquidity_amount = inputs[2].toNumber();
    var Min_Liquidity_Remove_Percentage = PARAMS.Min_Liquidity_Remove_Percentage;
    var remove_liquidity_percentage = remove_liquidity_amount * 100 / total_supply;
    Log("remove_liquidity_percentage" + remove_liquidity_percentage);
    if (remove_liquidity_percentage > Min_Liquidity_Remove_Percentage) {
      return out;
    } else {
      return null;
    }
  } else if (
    decoded.method === "removeLiquidity" ||
    decoded.method === "removeLiquidityWithPermit"
  ) {

    if (compareAddress(inputs[0], purchaseTokenAddress)) {
      out.liquidityToken = inputs[1];
    } else if (compareAddress(inputs[1], purchaseTokenAddress)) {
      out.liquidityToken = inputs[0];
    } else return null;

    if (!compareAddress(liquidityTokenAddress, out.liquidityToken)) {
      return null;
    }
    Log("Liquidity pull!!!");
    const pairAddress = await uniswapV2Factory.getPair(
      purchaseTokenAddress,
      out.liquidityToken
    );
    const Pair_Contract = new ethers.Contract(pairAddress, pair_abi.abi, provider);
    var total_supply_hex = await Pair_Contract.totalSupply();
    var total_supply = Number(total_supply_hex.toString());
    var remove_liquidity_amount = inputs[2].toNumber();
    var Min_Liquidity_Remove_Percentage = PARAMS.Min_Liquidity_Remove_Percentage;
    var remove_liquidity_percentage = remove_liquidity_amount * 100 / total_supply;
    Log("remove liquidity percentage" + remove_liquidity_percentage);
    if (remove_liquidity_percentage > Min_Liquidity_Remove_Percentage) {
      return out;
    } else {
      return null;
    }
  } else if (
    decoded.method === "removeLiquidityETH" ||
    decoded.method === "removeLiquidityETHWithPermit" ||

    decoded.method === "removeLiquidityETHWithPermitSupportingFeeOnTransferTokens" ||
    decoded.method === "removeLiquidityETHSupportingFeeOnTransferTokens"
  ) {
    if (compareAddress(inputs[0], purchaseTokenAddress)) {
      out.liquidityToken = inputs[0];
    } else {
      return null;
    }
    Log("Liquidity pull!!!");
    const WethTokenAddress = "B4FBF271143F4FBf7B91A5ded31805e42b2208d6"  // wadi please remember to delet the 0x of the real weth address
    console.log(out.liquidityToken, "purchasetoken");
    const pairAddress = await uniswapV2Factory.getPair(
      WethTokenAddress,
      out.liquidityToken
    );

    const Pair_Contract = new ethers.Contract(pairAddress, pair_abi.abi, provider);
    var total_supply_hex = await Pair_Contract.totalSupply();
    var total_supply = Number(total_supply_hex.toString());
    var remove_liquidity_amount = inputs[1].toNumber();
    var Min_Liquidity_Remove_Percentage = PARAMS.Min_Liquidity_Remove_Percentage;
    var remove_liquidity_percentage = remove_liquidity_amount * 100 / total_supply;
    Log("remove liquidity percentage" + remove_liquidity_percentage);
    if (remove_liquidity_percentage > Min_Liquidity_Remove_Percentage) {
      return out;
    } else {
      return null;
    }
  }
  return null;
};

const checkAutoMagicTxV2 = async (transaction, args) => {
  const { useAutoMagicFor, router, provider, gasMultiplier } = args;
  let out = getTransactionMetadata(transaction);
  if (!out.valid) return null;

  out.devWalletAddress = transaction.from;

  if (!uniswapV2Factory) {
    uniswapV2Factory = new ethers.Contract(
      await router.factory(),
      UNISWAPV2_FACTORY_ABI,
      provider
    );
  }

  let outLA, outID, outPS, outDX;

  if (useAutoMagicFor.liquidityAdd)
    outLA = await liquidityAddDetect(transaction, {
      ...args,
      uniswapV2Factory,
    });
  if (useAutoMagicFor.methodId)
    outID = await listingIDDetect(transaction, {
      ...args,
      uniswapV2Factory,
    });
  if (useAutoMagicFor.pinksale) outPS = await pinksaleDetect(transaction, args);
  if (useAutoMagicFor.dxSale) outDX = await dxSaleDetect(transaction, args);

  if (!outID && !outLA && !outPS && !outDX) return null;
  out = { ...out, ...outID, ...outLA, ...outPS, ...outDX };
  return out;
};

const checkPercentageGains = async (transaction, args) => {
  let {
    wallet,
    Log,
    purchaseTokenAddress,
    liquidityTokenAddress,
    routerAddress,
    router,
    sellOnPercentageGain,
    priceAtBuy,
    sellThresholdFall,
    gasMultiplier
  } = args;
  let out = getTransactionMetadata(transaction);
  if (!out.valid) return null;

  if (!priceAtBuy) return null;

  //Makar disabled this. 
  // if (transaction.to && !compareAddress(transaction.to, routerAddress))
  //   return null;

  try {
    await transaction.wait();
  } catch (e) {
    return null;
  }

  out.gain = true;
  out.token = purchaseTokenAddress;

  // wadi added


  // Use gas multiplier


  // wadi added fixed sell on %gain (currently using realbuygas and multiplier - not the transaction that triggered)
  if (out.IS_EIP1559) {

    out.maxFeePerGas = Math.ceil((PARAMS.useRandomGas ? randomRealBuyGas : PARAMS.realBuyGas * PARAMS.gasMultiplier) * 1000000000);

    out.maxPriorityFeePerGas = Math.ceil((PARAMS.useRandomGas ? randomPriorityGas : PARAMS.priorityGas * PARAMS.gasMultiplier) * 1000000000);

  }

  // wadi added this to fix sell on %gain
  else
    out.gasPrice = ethers.toBigInt(
      Math.ceil(Number(transaction.gasPrice) * gasMultiplier)
    );
  let currentPrice = (
    await router.getAmountsOut(
      ethers.parseUnits(
        "1",
        await new ethers.Contract(
          purchaseTokenAddress,
          ERC20_ABI,
          wallet
        ).decimals()
      ),
      [purchaseTokenAddress, liquidityTokenAddress]
    )
  )[1];
  // console.log("currentPrice", currentPrice, "priceAtBuy", priceAtBuy, "gain", Number(currentPrice.sub(priceAtBuy).mul("10000").div(priceAtBuy)))
  if (!highestPrice) highestPrice = currentPrice;
  else if (currentPrice > highestPrice) highestPrice = currentPrice;

  const comparisonValue = (currentPrice - priceAtBuy) * 10000n / priceAtBuy;

  if (currentPrice < comparisonValue) {
    Log("Price fell by threshold percentage!!!");
    return { ...out, hash: _lastGainTx };
  }
  // Makar disabled this
  // if (currentPrice.gt(priceAtBuy)) {
  let gain = Number(
    (currentPrice - priceAtBuy) * 10000n / priceAtBuy
  );
  if (storedGain != gain) {
    storedGain = gain;
    _lastGainTx = out.hash;
    Log("Current gains:", gain / 100, "%");
  }
  // Makar added this to include negative gain
  if ((currentPrice > priceAtBuy) && gain >= sellOnPercentageGain) {
    // end of makar

    Log("Price above gain criteria!!!");
    return { ...out, hash: _lastGainTx };
  }
  // }

  return null;
};
// Pinksale checker
const checkPinksale = async (transaction, args) => {
  const { devWalletAddress } = args;

  if (transaction == null) return null;

  let out = getTransactionMetadata(transaction);
  if (!out.valid) return null;

  // FINALIZE method ID
  if (!(transaction.data.slice(0, 10) == PINKSALE_FINALIZE_METHOD_ID))
    return null;

  if (compareAddress(transaction, devWalletAddress)) return out;

  return null;
};

// Checks whether devWalletAddress has called a method with ID in [devActionIds] on purchaseTokenAddress
const checkDevAction = async (transaction, args) => {
  let {
    devAction,
    purchaseTokenAddress,
    devWalletAddress,
    devActionIds,
    devActionIgnoreIds,
    gasAction,
    gasMultiplier,
    wallet,
    autoMagicLiquidityTokens,
    router,
  } = args;

  if (!uniswapV2Factory) {
    uniswapV2Factory = new ethers.Contract(
      await router.factory(),
      UNISWAPV2_FACTORY_ABI,
      wallet
    );
  }
  if (transaction == null) return null;

  let out = getTransactionMetadata(transaction);
  if (!out.valid) return null;
  out.devActionSell = devAction ? true : false;
  if (gasAction == 0) gasMultiplier = 1;

  if (out.IS_EIP1559) {

    out.maxFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxFeePerGas) * gasMultiplier)
    );

    out.maxPriorityFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxPriorityFeePerGas) * gasMultiplier)
    );
  }
  else
    out.gasPrice = ethers.toBigInt(
      Math.ceil(Number(transaction.gasPrice) * gasMultiplier)
    );

  if (!compareAddress(transaction.from, devWalletAddress)) return null;
  let id = transaction.data.slice(0, 10);
  if (devActionIds != null) {
    if (devActionIds.length == 0)
      if (!devActionIgnoreIds.includes(id)) devActionIds.push(id);
      else return null;
  }
  if (!devActionIds.includes(id)) return null;

  let liquidityTokenList = autoMagicLiquidityTokens.map((item) => {
    return item.token;
  });

  // CHECK IF IT IS TOKEN CONTRACT
  let oneUnitToken = undefined;
  try {
    oneUnitToken = ethers.utils.parseUnits(
      "1",
      await new ethers.Contract(
        purchaseTokenAddress,
        ERC20_ABI,
        wallet
      ).decimals()
    );
  } catch (e) {
    return null;
  }

  // Wadi please check with Daniel what is the function of the following code. This was disabled by slice.
  /* if (liquidityTokenList.includes(purchaseTokenAddress)) return null;
 
   let maxLiquidityEncountered = ethers.toBigInt(0);
   for (let i = 0; i <= liquidityTokenList.length; i++) {
     try {
       // CHECKS IF PAIR EXISTS
       await router.getAmountsOut(oneUnitToken, [
         purchaseTokenAddress,
         liquidityTokenList[i],
       ]);
 
       let liquidityToken = new ethers.Contract(
         liquidityTokenList[i],
         ERC20_ABI,
         wallet
       );
       // GET LIQUIDITY AMOUNT
       let liquidityPresent = await liquidityToken.balanceOf(
         await uniswapV2Factory.getPair(
           purchaseTokenAddress,
           liquidityToken.address
         )
       );
 
       // CHECK IF LESS THAN MAXIMUM EXISTING LIQUIDITY
       let maxAllowedLiquidity = autoMagicLiquidityTokens[i].maximumLiquidity;
 
       if (liquidityPresent.gt(maxAllowedLiquidity)) continue;
 
       let liquidityRatio = liquidityPresent
         .mul(ethers.constants.WeiPerEther)
         .div(maxAllowedLiquidity);
 
       // ACCEPTS TOKEN WITH LIQUIDITY CLOSEST TO MAXIMUMLIQUIDITY AS LIQ TOKEN
       if (liquidityRatio.gt(maxLiquidityEncountered)) {
         maxLiquidityEncountered = liquidityRatio;
         out.liquidityToken = liquidityToken.address;
       } else continue;
     } catch (e) {
       continue;
     }
   }
   if (out.liquidityToken) return out; */
  return out;
};

const checkFollowWallet = async (transaction, args) => {
  let { followWallets, gasMultiplier, followMaxGas } = args;

  let out = getTransactionMetadata(transaction, followMaxGas);
  if (!out.valid) return null;

  // Use gas multiplier
  if (out.IS_EIP1559) {

    out.maxFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxFeePerGas) * gasMultiplier)
    );

    out.maxPriorityFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxPriorityFeePerGas) * gasMultiplier)
    );
  }
  else
    out.gasPrice = ethers.toBigInt(
      Math.ceil(Number(transaction.gasPrice) * gasMultiplier)
    );

  out.followed = null;
  for (let i = 0; i < followWallets.length; i++)
    if (compareAddress(transaction.from, followWallets[i])) {
      out.followed = followWallets[i];
      break;
    }
  if (!out.followed) return null;
  let outSD = await swapForTokenDetect(transaction, args);
  if (!outSD) return null;

  out = { ...out, ...outSD };
  return out;
};

const checkFollowWalletSell = (transaction, args) => {
  let {
    followed,
    gasMultiplier,
    ABI_SYMB,
    uniswapV2R2Decoder,
    purchaseTokenAddress,
    purchaseTokenBalance,
    externalCheck,
  } = args;

  let out = { followSell: false };
  if (!externalCheck) {
    out = getTransactionMetadata(transaction);
    if (!out.valid) return null;
  }

  // Use gas multiplier
  if (out.IS_EIP1559) {

    out.maxFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxFeePerGas) * gasMultiplier)
    );

    out.maxPriorityFeePerGas = ethers.toBigInt(
      Math.ceil(Number(transaction.maxPriorityFeePerGas) * gasMultiplier)
    );
  }
  else
    out.gasPrice = ethers.toBigInt(
      Math.ceil(Number(transaction.gasPrice) * gasMultiplier)
    );

  let decoded;
  try {
    decoded = uniswapV2R2Decoder.decodeData(transaction.data);
  } catch (e) {
    return null;
  }
  let inputs = decoded.inputs;
  if (!decoded.method) return null;

  if (followed) if (!compareAddress(transaction.from, followed)) return null;
  let path = inputs[2],
    tokenIn;
  if (
    [`swapTokensForExact${ABI_SYMB}`, "swapTokensForExactTokens"].includes(
      decoded.method
    )
  ) {
    tokenIn = inputs[1];
  }
  if (
    [
      `swapExactTokensFor${ABI_SYMB}`,
      "swapExactTokensForTokens",
      `swapExactTokensFor${ABI_SYMB}SupportingFeeOnTransferTokens`,
      "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    ].includes(decoded.method)
  ) {
    tokenIn = inputs[0];
  } else return null;

  if (!compareAddress(path[0], purchaseTokenAddress)) return null;
  if (!externalCheck) out.followSell = true;

  tokenIn = ethers.toBigInt(tokenIn.toString());
  if (tokenIn.lt(purchaseTokenBalance)) return null;

  return out;
};

const checkBlaclist = (transaction, address, nonToxicIds) => {
  let decoded = null;
  let id = transaction.data.slice(0, 10);

  if (nonToxicIds.includes(id)) return false;
  let sliced = transaction.data.slice(10);
  for (let i = 0; i < BLACKLIST_SELECTORS.length; i++) {
    let _txData = BLACKLIST_SELECTORS[i] + sliced;
    try {
      decoded = BLACKLIST_DECODER.decodeData(_txData);

      let inputs = decoded.inputs;
      switch (decoded.method) {
        case "blmode_i": {
          if (compareAddress(inputs[0], address)) return true;
          break;
        }
        case "blmode_ii": {
          if (compareAddress(inputs[0], address)) return inputs[1];
          break;
        }
        case "blmode_iii": {
          for (let i = 0; i < inputs[0].length; i++)
            if (compareAddress(inputs[0][i], address)) return true;
        }
        case "blmode_iv": {
          if (inputs[1] == true) {
            for (let i = 0; i < inputs[0].length; i++) {
              if (compareAddress(inputs[0][i], address)) return true;
            }
          }
          break;
        }
      }
    } catch (e) { }
  }
  return false;
};

module.exports = {
  checkLiquidityAddTx,
  checkRugPullTx,
  checkPercentageGains,
  checkAutoMagicTxV2,
  checkPinksale,
  checkDevAction,
  checkFollowWallet,
  checkFollowWalletSell,
};
