const ethers = require('ethers')
const { toChecksumAddress } = require('ethereum-checksum-address')
//const { ERC20_ABI, required, generateTID } = require("./utils");
// added by Max Gwei coder ... Keith
const {
  ERC20_ABI,
  required,
  generateTID,
  compareAddress,
  getRandomNumber
} = require('./utils')
const UNIV2ROUTERABI = require('../abi/UniswapV2Router02.json')
const PARAMS = require('../params.json')
const NETWORK_DATA = require('../networkData.json')
const { Log } = require('./logger')
var slippage = PARAMS?.MAX_SLIPPAGE ? PARAMS?.MAX_SLIPPAGE : 100
slippage = slippage * 100
// end of paste
let nodeID, mode, logger, wallet, tokenTracker, constructTxUrl

const initUpdaters = (
  _nodeID,
  _mode,
  _logger,
  _wallet,
  _tokenTracker,
  _constructTxUrl
) => {
  nodeID = _nodeID
  mode = _mode
  logger = _logger
  wallet = _wallet
  tokenTracker = _tokenTracker
  constructTxUrl = _constructTxUrl
}
const updateLiquidityToken = async (
  _newAddress,
  _minimumLiquidity,
  _maximumLiquidity
) => {
  let states = {
    liquidityToken: { address: null },
    minimumLiquidity: 0n,
    maximumLiquidity: 0n
  }

  if (!['Fairlaunch'].includes(mode)) required(_newAddress, 'liquidityToken') // TODO add auto-magic sometime
  if (_newAddress) {
    states.liquidityToken = new ethers.Contract(
      required(_newAddress, 'liquidityToken'),
      ERC20_ABI,
      wallet
    )
    states.minimumLiquidity = ethers.parseUnits(
      String(_minimumLiquidity),
      await states.liquidityToken.decimals()
    )
    states.maximumLiquidity = ethers.parseUnits(
      String(_maximumLiquidity),
      await states.liquidityToken.decimals()
    )

    logger('Liquidity Token set to:', await states.liquidityToken.symbol())
  }

  return states
}

const updatePurchaseToken = async (
  _purchaseTokenAddress,
  _tokenBuyAmount,
  _realBuyMethod
) => {
  let states = {
    purchaseToken: null,
    tokenBuyAmount: 0n,
    realBuyMethod: _realBuyMethod
  }

  states.purchaseToken = new ethers.Contract(
    _purchaseTokenAddress,
    ERC20_ABI,
    wallet
  )
  let _purchaseTokenDecimals = await states.purchaseToken.decimals()

  let _symb = await states.purchaseToken.symbol()
  try {
    states.tokenBuyAmount = ethers.parseUnits(
      String(_tokenBuyAmount),
      _purchaseTokenDecimals
    )
  } catch (e) {
    if (_realBuyMethod == 0) {
      logger(
        `Token with low decimals encountered! Switching to "realBuyMethod ${1}..."`
      )
      states.realBuyMethod = 1
    }
  }
  let _adx = states.purchaseToken.target
  _adx = toChecksumAddress(_adx)
  //logger("Token to buy:", _adx);
  logger('View more at:', `https://${tokenTracker}/${_adx}`)
  logger(`Updated Purchase token -> ${_symb}(${states.purchaseToken.target})`)

  return states
}

const formatLiquidityTokenParams = async _liquidityTokens => {
  //logger("Setting liquidity token values...");
  for (let i = 0; i < _liquidityTokens.length; i++) {
    let item = _liquidityTokens[i]
    // logger("Updating values for:", item.token);
    let _token = new ethers.Contract(item.token, ERC20_ABI, wallet)
    let _decimals = await _token.decimals()
    item.minimumLiquidity = ethers.parseUnits(
      String(item.minimumLiquidity),
      _decimals
    )
    item.maximumLiquidity = ethers.parseUnits(
      String(item.maximumLiquidity),
      _decimals
    )
  }
  //logger("Updated all values.");
  return _liquidityTokens
}

const executeApprove = async (
  _privatekeys,
  _tokenAddress,
  _to,
  _exit = false
) => {
  const _token = new ethers.Contract(_tokenAddress, ERC20_ABI, wallet)
  // if (nodeID == 0) { // FIXME check only when approving before winnerNode
  const promises = []
  let idx
  for (idx = 0; idx < _privatekeys.length; idx++) {
    promises.push(
      executeApproveForWallet(
        new ethers.Wallet(_privatekeys[idx], wallet.provider),
        _token,
        _to
      )
    )
  }
  await Promise.all(promises)

  if (_exit && idx == _privatekeys.length - 1) process.exit(0)
  return true
}

const executeApproveForWallet = async (_wallet, _token, _to) => {
  _token = _token.connect(_wallet)
  let _tokenSymb = await _token.symbol()

  logger(`Approving ${_tokenSymb}: From ${_wallet.address} -> To ${_to}...`)
  if (
    (await _token.allowance(_wallet.address, _to)) >
    ethers.MaxUint256 / 100n
  ) {
    logger('ALREADY APPROVED!')
    return true
  }
  try {
    let tx = await _token.approve(_to, ethers.MaxUint256)
    await tx.wait()
    logger(
      `APPROVE SUCCESSFUL - ${_tokenSymb}: From ${_wallet.address} -> To ${_to}...`,
      `${constructTxUrl(tx)}`
    )
    return true
  } catch (err) {
    logger(
      `!APPROVE FAILED - ${_tokenSymb}: From ${_wallet.address} -> To ${_to}`,
      err
    )
    return false
  }
}

const generateBuyTx = async (
  _buybot,
  _round,
  _router,
  _purchaseTokenAddress,
  _liquidityTokenAddress,
  _wethAddress,
  _realBuyMethod,
  _tokenBuyAmount,
  _wethSellAmount,
  _recipients,
  _useChecks,
  _checkSellebility,
  _wethForChecks,
  _maxBuyTax,
  _maxSellTax
) => {
  let states = { currentTXID: null, tx: null }
  let TXID = generateTID(_round)
  states.currentTXID = TXID
  if (!_liquidityTokenAddress || !_purchaseTokenAddress) {
    logger('`liquidityToken` or `purchaseToken` not found!')
    return
  }
  logger('Generating transaction data for round:', _round + 1)
  // max gwei code - Keith
  //console.log("Buy amount", _tokenBuyAmount, _wethSellAmount)
  const uniRouter = new ethers.Contract(_router, UNIV2ROUTERABI, wallet)

  if (1 == PARAMS.maxBuySafe && 0 == _realBuyMethod) {
    const path =
      _liquidityTokenAddress &&
      0 == compareAddress(_liquidityTokenAddress, _wethAddress)
        ? [_wethAddress, _liquidityTokenAddress, _purchaseTokenAddress]
        : [_wethAddress, _purchaseTokenAddress]
    //console.log("Path of WeGo2Mars", path);
    //console.log("Checking if Max_Weth_Spend exceeds cost of TokenbuyAmount");
    const amountIn = ethers.parseEther(PARAMS.Max_Weth_Spend.toString())

    // stoping from sending max weth spend tx wadi
    const amountsOut = await uniRouter.getAmountsOut(amountIn, path)
    const ao = amountsOut[path.length - 1]

    if (_tokenBuyAmount && _tokenBuyAmount.gt(ao)) {
      console.log('TokenbuyAmount cost exceeds Max_Weth_Spend Standing down!!!')
      //_tokenBuyAmount = ao;
      return states
    }
  }

  let tx = []
  // max gwei end
  if (PARAMS.TradeWithContract === true) {
    var ttx = await _buybot.swapExactETHForTokens.populateTransaction(
      _router,
      _purchaseTokenAddress,
      _liquidityTokenAddress ? _liquidityTokenAddress : _wethAddress,
      _realBuyMethod,
      [_tokenBuyAmount ? _tokenBuyAmount : '0', _wethSellAmount],
      _recipients,
      _useChecks,
      _checkSellebility,
      _wethForChecks,
      [_maxBuyTax, _maxSellTax],
      TXID
    )
    tx.push(ttx)
  } else {
    // const WETH = new ethers.Contract(_wethAddress, ERC20_ABI, wallet);
    const TOKEN = new ethers.Contract(_purchaseTokenAddress, ERC20_ABI, wallet)
    const TOKEN_DECIMAL = await TOKEN.decimals()
    var path = []
    const tempLiquidityTokenAddress = _liquidityTokenAddress
      ? _liquidityTokenAddress
      : _wethAddress
    if (_wethAddress === tempLiquidityTokenAddress) {
      path = [_wethAddress, _purchaseTokenAddress]
    } else {
      path = [_wethAddress, tempLiquidityTokenAddress, _purchaseTokenAddress]
    }
    const keys = PARAMS.privatekeys
    for (var i = 0; i < keys.length; i++) {
      var _wallet = new ethers.Wallet(keys[i], wallet.provider)
      var _uniRouter = uniRouter.connect(_wallet)
      var ttx
      if (PARAMS.maxWalletBuy == true) {
        const maxWallet = await getMaxTokenAmount(TOKEN)
        // const maxWallet = await TOKEN.antiWhaleLimit()
        // walletMax, maxWallet, maxBalance, walletLimit,antiWhaleLimit
        Log(
          'Max wallet limit: ',
          maxWallet.toString(),
          `|| ${ethers.formatUnits(maxWallet.toString(), TOKEN_DECIMAL)}`
        )
        const currentBalance = await TOKEN.balanceOf(_wallet.address)
        Log(
          'Current wallet balance: ',
          currentBalance.toString(),
          `|| ${ethers.formatUnits(currentBalance.toString(), TOKEN_DECIMAL)}`
        )
        const amountToBuy = maxWallet - currentBalance
        Log(
          'amountToBuy: ',
          amountToBuy,
          `|| ${ethers.formatUnits(
            BigInt(amountToBuy).toString(),
            TOKEN_DECIMAL
          )}`
        )
        const amountToBuyFormated = BigInt(amountToBuy)
        const walletBalance = await _wallet.getBalance()
        const formatedEther = ethers.formatEther(walletBalance)
        const precision = 12
        const divisor = BigInt(10) ** BigInt(precision)
        const truncatedValue = amountToBuyFormated.div(divisor).mul(divisor)
        Log(`This is amountToBuyFormated: ${amountToBuyFormated}`)
        Log(`This is truncatedValue: ${truncatedValue}`)

        ttx = await _uniRouter.swapETHForExactTokens.populateTransaction(
          truncatedValue
            ? `${truncatedValue
                .mul(10000 - (PARAMS.Use_Slippage ? slippage : 0))
                .div(10000)}`
            : '0',
          path,
          _wallet.address,
          parseInt(Date.now() / 1000) + 1000,
          { value: ethers.parseEther((formatedEther - 0.06).toString()) }
        )
      } else {
        if (_realBuyMethod == 0) {
          const walletBalance = await _wallet.getBalance()
          const formatedEther = ethers.formatEther(walletBalance)
          ttx = await _uniRouter.swapETHForExactTokens.populateTransaction(
            _tokenBuyAmount
              ? `${_tokenBuyAmount
                  .mul(10000 - (PARAMS.Use_Slippage ? slippage : 0))
                  .div(10000)}`
              : '0',
            path,
            _wallet.address,
            parseInt(Date.now() / 1000) + 1000,
            { value: ethers.parseEther((formatedEther - 0.06).toString()) }
          )
        } else if (_realBuyMethod == 1) {
          // ttx =
          //   await _uniRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens.populateTransaction(
          //     _wethSellAmount,
          //     1,
          //     path,
          //     _wallet.address,
          //     parseInt(Date.now() / 1000) + 100
          //   );

          if (_wethSellAmount !== 0) {
            const amountsOut = await _uniRouter.getAmountsOut(
              _wethSellAmount,
              path
            )
            const ao = amountsOut[path.length - 1]
            ttx =
              await _uniRouter.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
                PARAMS.Use_Slippage ? ao.mul(10000 - slippage).div(10000) : 0,
                path,
                _wallet.address,
                parseInt(Date.now() / 1000) + 1000,
                {
                  value: _wethSellAmount
                }
              )
          }
        } else if (_realBuyMethod == 2) {
          const rands = PARAMS.wethSellRandomAmount
          const randNumber = getRandomNumber(rands[0], rands[1])
          const parsedNumber = ethers.parseEther(`${randNumber.toFixed(10)}`)
          const amountsOut = await _uniRouter.getAmountsOut(parsedNumber, path)
          const ao = amountsOut[path.length - 1]
          ttx =
            await _uniRouter.swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
              PARAMS.Use_Slippage ? ao.mul(10000 - slippage).div(10000) : 0,
              path,
              _wallet.address,
              parseInt(Date.now() / 1000) + 1000,
              {
                value: parsedNumber
              }
            )
        } else if (_realBuyMethod == 3) {
          const rands = PARAMS.tokenRandomBuyAmount
          const randNumber = getRandomNumber(rands[0], rands[1])
          const parsedNumber = ethers.parseUnits(
            randNumber.toString(),
            TOKEN_DECIMAL
          )
          const walletBalance = await _wallet.getBalance()
          var formatedEther = ethers.formatEther(walletBalance)
          if (formatedEther > 0.005) {
            const amountsIn = await _uniRouter.getAmountsIn(
              parsedNumber
                .mul(10000 - (PARAMS.Use_Slippage ? slippage : 0))
                .div(10000),
              path
            )
            const ao = ethers.parseEther(
              parseFloat(
                ethers.formatEther(amountsIn[0].mul(2)).toString()
              ).toFixed(18)
            )
            ttx = await _uniRouter.swapETHForExactTokens.populateTransaction(
              parsedNumber
                .mul(10000 - (PARAMS.Use_Slippage ? slippage : 0))
                .div(10000),
              path,
              _wallet.address,
              parseInt(Date.now() / 1000) + 1000,
              {
                value: ethers.parseEther((formatedEther - 0.06).toString())
              }
            )
          }
        }
      }
      tx.push(ttx)
    }
  }

  states.tx = tx
  return states
}

const generateRugPullTx = async (
  _buybot,
  _router,
  _purchaseTokenAddress,
  _liquidityTokenAddress,
  _recipients,
  _params
) => {
  var tx = []
  if (PARAMS.TradeWithContract === true) {
    var _ttx = await _buybot.swapExactTokensForETH.populateTransaction(
      _router,
      _purchaseTokenAddress,
      _liquidityTokenAddress,
      _recipients,
      _params
    )
    tx.push(_ttx)
  } else {
    var keys = PARAMS.privatekeys
    const uniRouter = new ethers.Contract(_router, UNIV2ROUTERABI, wallet)
    const WETH = new ethers.Contract(
      NETWORK_DATA[PARAMS.network].wrapped,
      ERC20_ABI,
      wallet
    )
    const TOKEN = new ethers.Contract(_purchaseTokenAddress, ERC20_ABI, wallet)
    var path = []
    if (WETH.target === _liquidityTokenAddress) {
      path = [_purchaseTokenAddress, WETH.target]
    } else {
      path = [_purchaseTokenAddress, _liquidityTokenAddress, WETH.target]
    }

    for (var i = 0; i < keys.length; i++) {
      var _wallet = new ethers.Wallet(keys[i], wallet.provider)
      var balance = await TOKEN.balanceOf(_wallet.address)
      var sellAmount

      if (_params[0] > 0) {
        sellAmount = (balance * _params[0]) / ethers.parseEther('1')
      } else {
        sellAmount = _params[1] < balance ? _params[1] : balance
      }
      var _uniRouter = uniRouter.connect(_wallet)
      if (parseFloat(sellAmount.toString()) !== 0) {
        try {
          const amountsOut = await _uniRouter.getAmountsOut(sellAmount, path)
          const ao = amountsOut[path.length - 1]
          var _ttx =
            // await _uniRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens.populateTransaction(
            //   sellAmount,
            //   1,
            //   path,
            //   _wallet.address,
            //   parseInt(Date.now() / 1000) + 2000
            // );

            await _uniRouter.swapExactTokensForETHSupportingFeeOnTransferTokens.populateTransaction(
              sellAmount,
              // ao.mul(10000 - (PARAMS.Use_Slippage ? slippage : 0)).div(10000),
              0,
              path,
              _wallet.address,
              parseInt(Date.now() / 1000) + 2000
            )
          tx.push(_ttx)
        } catch (err) {
          console.log('generateRugPullTx=>', err)
        }
      } else {
        // console.log("The sellAmount is zero, so skip this transaction.");
      }
    }
  }

  return tx
}

// Added by @Amir to use maxWalletAmount
async function getMaxTokenAmount (TOKEN) {
  const possibleFunctions = [
    'walletMax',
    'maxWallet',
    'maxBalance',
    'walletLimit',
    'antiWhaleLimit'
  ]

  for (const limitFunction of possibleFunctions) {
    try {
      const maxWallet = await TOKEN[limitFunction]()
      console.log(
        `Function "${limitFunction}" found. Max token amount:`,
        maxWallet.toString()
      )
      if (maxWallet) return maxWallet
    } catch (error) {
      console.log(`Function "${limitFunction}" not found or failed.`)
    }
  }
  throw new Error('None of the possible functions were found in the contract.')
}

module.exports = {
  initUpdaters,
  executeApprove,
  updateLiquidityToken,
  updatePurchaseToken,
  formatLiquidityTokenParams,
  generateBuyTx,
  generateRugPullTx
}
