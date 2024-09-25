const ethers = require('ethers')
const fs = require('fs')
const InputDataDecoder = require('ethereum-input-data-decoder')
const { initLogger, Log, LogFatalException } = require('./logger')
const {
  initUpdaters,
  updateLiquidityToken,
  updatePurchaseToken,
  executeApprove,
  generateRugPullTx,
  generateBuyTx,
  formatLiquidityTokenParams
} = require('./updaters')
const { getCliArgs } = require('./argParser')
const {
  initUtils,
  ERC20_ABI,
  BUYBOT_ABI,
  getAddressFromPARAM,
  getBalanceOfTokenFmt,
  required,
  assertLog,
  formatMaxTaxes,
  constructTxUrl,
  getTxFailReasonLite,
  getTxFailStatus,
  getRandomNumber,
  constructTxUrlget
} = require('./utils')
const {
  checkLiquidityAddTx,
  checkRugPullTx,
  checkPercentageGains,
  checkAutoMagicTxV2,
  checkPinksale,
  checkDevAction,
  checkFollowWallet,
  checkFollowWalletSell
} = require('./transactionCheckers')
const { options } = require('./dev/options')
const PARAMS = require('../params.json')

let _NETWORK_DATA = require('../networkData.json')
const readline = require('readline')
const { log } = require('console')

const { sendTransactionsViaFlashbots } = require('../flashbots')
const { sendTransactionsViaFlashbotsBundle } = require('../flashbotsBundle')

readline.emitKeypressEvents(process.stdin)
if (process.stdin.setRawMode) process.stdin.setRawMode(true)

const { index, runID, nodeID } = getCliArgs()
const mode = options[index]
var NETWORK_DATA

NETWORK_DATA = _NETWORK_DATA[required(PARAMS.network, 'network')]

initLogger(nodeID, runID)
const cachePath = `./cache/${runID}.json`

let _executeSell, resetForAutoMagic, init

var provider
const checkNetwork = () => {
  if (NETWORK_DATA) {
    provider = new ethers.WebSocketProvider(
      required(NETWORK_DATA.websockets[nodeID], 'websocket')
    )

    let errInit = () => {
      // provider._websocket.on('error', async err => {
      //   const RETRY_TIME = 3000
      //   Log(`${err}: Unable to connect, retrying in ${RETRY_TIME / 1000}s...`)
      //   if (init) setTimeout(init, RETRY_TIME)
      //   else setTimeout(errInit, RETRY_TIME)
      // })
      // provider.onNetworkEvent("error", async (err) => {
      //   const RETRY_TIME = 3000;
      //   console.log(`${err}: Unable to connect, retrying in ${RETRY_TIME / 1000}s...`);

      //   // Retry the network initialization after a delay
      //   if (checkNetwork) {
      //     setTimeout(checkNetwork, RETRY_TIME);
      //   } else {
      //     setTimeout(errInit, RETRY_TIME);
      //   }
      // });
      provider.websocket.on('error', async err => {
        const RETRY_TIME = 3000
        console.log(
          `${err}: Unable to connect, retrying in ${RETRY_TIME / 1000}s...`
        )

        // Retry network initialization
        setTimeout(checkNetwork, RETRY_TIME)
      })

      provider.websocket.on('close', async code => {
        const RETRY_TIME = 3000
        console.log(
          `Connection closed with code ${code}. Retrying in ${
            RETRY_TIME / 1000
          }s...`
        )

        // Retry network initialization after a delay
        setTimeout(checkNetwork, RETRY_TIME)
      })
    }
    errInit()
  }
}
checkNetwork()

let wallet, recipients
let privatekey = required(PARAMS.privatekeys[0], 'privatekey')
const checkWallet = () => {
  if (provider) {
    try {
      wallet = new ethers.Wallet(privatekey, provider)
      recipients = PARAMS.privatekeys.map(pk => {
        return new ethers.Wallet(pk, provider).address
      })
      if (!PARAMS.includeSender) {
        assertLog(
          recipients.length != 1,
          'Either turn on `includeSender` or specify other recipients!'
        )
        recipients = recipients.slice(1)
      }
      Log('Recipients:', recipients)
    } catch {
      LogFatalException('Invalid private key.')
    }
  }
}
checkWallet()
if (NETWORK_DATA || wallet) {
  initUpdaters(
    nodeID,
    mode,
    Log,
    wallet,
    NETWORK_DATA.tokenTracker,
    constructTxUrl
  )
}

let devWalletAddress = getAddressFromPARAM(PARAMS.devWallet)

var BLOCK_EXPLORER_TX,
  WETH,
  ABI_SYMB,
  WSYMB,
  uniswapV2R2Decoder,
  autoMagicLiquidityTokens,
  buyBot,
  router
let IS_EIP1559_AVAILABLE

const checkContract = () => {
  IS_EIP1559_AVAILABLE = NETWORK_DATA.eip1559
  required(IS_EIP1559_AVAILABLE, 'networkData.eip1559')
  BLOCK_EXPLORER_TX = `https://${NETWORK_DATA.explorer}/tx/`
  WETH = new ethers.Contract(NETWORK_DATA.wrapped, ERC20_ABI, wallet)
  ABI_SYMB = NETWORK_DATA.abitoken.toUpperCase()
  WSYMB = NETWORK_DATA.currency
  uniswapV2R2Decoder = new InputDataDecoder(require(NETWORK_DATA.abi))
  autoMagicLiquidityTokens = NETWORK_DATA.autoMagicLiquidityTokens

  buyBot = new ethers.Contract(NETWORK_DATA.contract, BUYBOT_ABI, wallet)
  required(NETWORK_DATA.router, 'router')
  router = new ethers.Contract(
    NETWORK_DATA.router,
    require(NETWORK_DATA.abi),
    wallet
  )
  initUtils(Log, BLOCK_EXPLORER_TX)
}

if (NETWORK_DATA) {
  checkContract()
}
const sellOnPercentageGain = PARAMS.sellOnPercentageGain
  ? PARAMS.sellOnPercentageGain * 100
  : null
let stopAfterFirstTx = PARAMS.stopAfterFirstTx // FIXME check implementation
if ((sellOnPercentageGain || PARAMS.antiRugPull) && !stopAfterFirstTx) {
  Log(
    'Turned on `stopAfterFirstTx` since `sellOnPercentageGain` or/and `antiRugPull` is enabled.'
  )
  stopAfterFirstTx = true
}

let purchaseToken = { address: undefined },
  tokenBuyAmount,
  sellToken
let liquidityToken = { address: undefined },
  minimumLiquidity,
  maximumLiquidity
if (mode == 'Instant Sell')
  sellToken = new ethers.Contract(
    required(PARAMS.sellToken, 'sellToken'),
    ERC20_ABI,
    wallet
  )

let balanceCheckMultiplier = String(
  PARAMS.balanceCheckMultiplier ? PARAMS.balanceCheckMultiplier : 1
)

let sellThresholdFall
if (sellOnPercentageGain)
  sellThresholdFall = String(
    required(PARAMS.sellThresholdFall, 'sellThresholdFall')
  )

let realBuyMethod = required(PARAMS.realBuyMethod, 'realBuyMethod')
!PARAMS.useChecks && Log('Tax checker turned off.')

const wethSellAmount = ethers.parseEther(
  String(required(PARAMS.wethSellAmount, 'wethSellAmount'))
)
const wethForChecks = PARAMS.useChecks
  ? ethers.parseEther(String(required(PARAMS.wethForChecks, 'wethForChecks')))
  : '0'

if (!PARAMS.checkSellebility && PARAMS.useChecks)
  Log('Sell tax checker turned off.')

const maxBuyTax = formatMaxTaxes(
  PARAMS.maxBuyTax,
  PARAMS.maxBuyTax,
  PARAMS.useChecks,
  'buy',
  Log
)
const maxSellTax = formatMaxTaxes(
  PARAMS.maxSellTax,
  PARAMS.maxSellTax && PARAMS.checkSellebility,
  PARAMS.useChecks,
  'sell',
  Log
)

const realBuyGas = PARAMS.realBuyGas
  ? ethers.parseUnits(String(PARAMS.realBuyGas), 9)
  : null

const priorityGas = PARAMS.priorityGas
  ? ethers.parseUnits(String(PARAMS.priorityGas), 9)
  : null
required(PARAMS.gasLimit, 'gasLimit')

// pasting slice's approve Gas
/*
const approveGas = {
  ...(PARAMS.approveGas?.priorityGas
    ? {
      maxPriorityFeePerGas: ethers.parseUnits(
        PARAMS.approveGas.priorityGas.toString(),
        9
      ),
    }
    : {}),
  ...(PARAMS.approveGas?.realBuyGas
    ? {
      maxFeePerGas: ethers.parseUnits(
        PARAMS.approveGas.realBuyGas.toString(),
        9
      ),
    }
    : {}),
  ...(PARAMS.approveGas?.gasLimit
    ? {
      gasLimit: PARAMS.approveGas?.gasLimit ?? null,
    }
    : {}),
}
*/
// end of paste for Slice's approve Gas

let followMaxGas = {}
const updateFollowMaxGas = () => {
  followMaxGas.gasPrice = NETWORK_DATA.followMaxGas.price
    ? ethers.parseUnits(String(NETWORK_DATA.followMaxGas.price), 9)
    : ethers.MaxUint256
  followMaxGas.maxFeePerGas = NETWORK_DATA.followMaxGas.price
    ? ethers.parseUnits(String(NETWORK_DATA.followMaxGas.price), 9)
    : ethers.MaxUint256
}

if (NETWORK_DATA) {
  updateFollowMaxGas()
}
// Transaction scheduling parameters
const waitBeforeFirstBuy = PARAMS.waitBeforeFirstBuy * 1000 // convert to milliseconds
const delayBetweenBuys = PARAMS.delayBetweenBuys * 1000 // convert to milliseconds
let roundsToBuy = PARAMS.roundsToBuy

// Internal vars
let detectRugPullNowOn = false,
  detectGainsNowOn = false,
  detectFollowSellNowOn = false,
  priceAtBuy = null,
  firstTxCaught = false
let args = { init: false }

// -------------------------------- Transaction scheduling helper vars ---------------------------------
let currentBlock
let txByBlock = {} // Maintains transactions that are needed to be done at a specific block
let txObjects = [] // Used for checking if all the transactions have succeeded

let lastOut, lastGasPrice
let retryRounds = PARAMS.retryRounds,
  retriesCompleted = 0,
  retryDelay = PARAMS.retryDelay * 1000
let pauseSearch = false,
  inSecondStage = false,
  followed = null
let purchaseTokenBalance, previousToken

// Caches the transaction to send it faster
let rawTx = { tx: null, round: null }

let secondStageTx
let currentTXID = undefined

// --------------------------------- --------------------------------- ---------------------------------

const updateBuyTx = async round => {
  let states = await generateBuyTx(
    buyBot,
    round,
    NETWORK_DATA.router,
    purchaseToken.target,
    liquidityToken.target,
    WETH.target,
    realBuyMethod,
    tokenBuyAmount,
    wethSellAmount,
    recipients,
    PARAMS.useChecks,
    PARAMS.checkSellebility,
    wethForChecks,
    maxBuyTax,
    maxSellTax
  )

  currentTXID = states.currentTXID
  // rawTx = { tx: states.tx, round };
  rawTx = []
  for (var i = 0; i < states.tx.length; i++) {
    rawTx.push({
      tx: states.tx[i],
      round: round
    })
  }
}

const updateSecondStageTx = async () => {
  // Log("Generating transaction data for sell event...");
  secondStageTx = await generateRugPullTx(
    buyBot,
    NETWORK_DATA.router,
    purchaseToken.target,
    liquidityToken.target,
    recipients,
    [ethers.WeiPerEther, 0]
  )
}

resetForAutoMagic = async () => {
  if (!['Auto-Magic', 'Follow Wallets'].includes(mode)) process.exit()

  Log('Resetting for sniping new tokens!')

  purchaseToken = { address: undefined }
  tokenBuyAmount = undefined
  sellToken = undefined
  liquidityToken = { address: undefined }
  minimumLiquidity = undefined
  maximumLiquidity = undefined
  secondStageTx = []
  detectGainsNowOn = detectRugPullNowOn = detectFollowSellNowOn = false
  rawTx = []
  args.init = false
  inSecondStage = false
  priceAtBuy = undefined
  pauseSearch = false
  stopAfterFirstTx = false
  firstTxCaught = false
  txObjects = []
  retriesCompleted = 0
  retryRounds = PARAMS.retryRounds
  followed = null
  purchaseTokenBalance = null
}

console.log()

let continuousBuyExecute
let globalFailed = 0
const pushTxObject = async (round, txObj) => {
  txObjects.push([round, txObj])

  let txLength = txObjects.length
  if (txObjects.length != roundsToBuy) return

  // When all the rounds have been completed, check their statuses, if any have failed, purge from object
  //Log("Fetching transaction data for all rounds...")
  let failed = globalFailed
  globalFailed = 0

  txObjects.forEach(async ([round, tx], idx) => {
    // Use Random RealBuyGas
    const randsRealBuyGas = PARAMS.randomRealBuyGas
    const randomRealBuyGas = getRandomNumber(
      randsRealBuyGas[0],
      randsRealBuyGas[1]
    ).toFixed(0)

    const randomRealBuyGasFormated = randomRealBuyGas
      ? ethers.parseUnits(String(randomRealBuyGas), 9)
      : null

    if (tx != 'EXECUTED') {
      if (PARAMS.useFlashBots) {
        // failed += 1
        txObjects = txObjects.filter((_, _idx) => {
          return _idx != idx
        })
      } else {
        if (await getTxFailStatus(tx, provider, round, Log)) {
          failed += 1
          txObjects = txObjects.filter((_, _idx) => {
            return _idx != idx
          })
        }
      }
    }

    // If last tx is not being checked, keep checking
    if (idx != txLength - 1) return
    
    if (failed > 0) {
      Log(`${failed} transaction(s) failed!`)
      Log("retriesCompleted, retryRounds=>", retriesCompleted, retryRounds)
      if (retriesCompleted != retryRounds) {
        if (!mode.includes('Instant') && !mode.includes('Approve')) {
          if (lastGasPrice) {
            if (lastOut.IS_EIP1559) {
              lastOut
              // lastOut.maxPriorityFeePerGas = ethers.BigNumber.from(
              //   Math.ceil(Number(priorityGas) * PARAMS.gasMultiplier)
              // );
            } else
              lastOut.gasPrice = ethers.BigNumber.from(
                Math.ceil(
                  Number(
                    PARAMS.useRandomGas ? randomRealBuyGasFormated : realBuyGas
                  ) * PARAMS.gasMultiplier
                )
              )
          }

          txObjects = []
          await updateBuyTx(0)

          Log(
            `Starting buys for ${failed} failed rounds with ${
              delayBetweenBuys / 1000
            }s delay between rounds after ${retryDelay / 1000}s.`
          )
          if (lastGasPrice) {
            if (lastOut.gasPrice)
              Log(
                `New gasPrice: ${ethers.formatUnits(lastOut.gasPrice, 9)} GWEI`
              )
            if (lastOut.maxPriorityFeePerGas)
              Log(
                `New maxPriorityFeePerGas: ${ethers.formatUnits(
                  lastOut.maxPriorityFeePerGas,
                  9
                )} GWEI`
              )
          }
          setTimeout(
            () => continuousBuyExecute(lastOut, failed, delayBetweenBuys, 0),
            retryDelay
          )
          retriesCompleted++
        }
      } else {
        Log('All retries exhausted!')
        if (PARAMS.stopAfterFirstTx) process.exit()
      }
    } else {
      Log('Transaction(s) SUCCESSFUL!')
      // wadi disabling approve because we moved it right after buy
      /* if (
         PARAMS.antiRugPull ||
         PARAMS.sellOnPercentageGain ||
         PARAMS.sellApprove
       ) {
         inSecondStage = true
         await executeApprove(
           PARAMS.privatekeys,
           purchaseToken.address,
           buyBot.address
         )
         await updateSecondStageTx()
       }*/
      if (PARAMS.sellOnPercentageGain) {
        detectRugPullNowOn = true
      }

      if (mode == 'Follow Wallets') detectFollowSellNowOn = true

      // Log("sellOnPercentageGain=>", purchaseToken.address, liquidityToken.address, purchaseToken, liquidityToken)
      if (sellOnPercentageGain) {
        detectGainsNowOn = true
        //Log("Fetching current price...")
        priceAtBuy = (
          await router.getAmountsOut(
            ethers.parseUnits('1', await purchaseToken.decimals()),
            [purchaseToken.target, liquidityToken.target]
          )
        )[1]

        args.priceAtBuy = priceAtBuy
        Log(
          'Price at buy is:',
          ethers.formatUnits(priceAtBuy, await liquidityToken.decimals()),
          await liquidityToken.symbol()
        )
        Log(
          `The bot will sell tokens once the price increases by ${
            sellOnPercentageGain / 100
          }%.`
        )
      }

      //Log("Balances after Buy:")
      Log(
        `Contract ${WSYMB} balance:`,
        ethers.formatEther(await WETH.balanceOf(buyBot.target))
      )
      purchaseTokenBalance = await purchaseToken.balanceOf(wallet.address)
      args.purchaseTokenBalance = purchaseTokenBalance
      Log(
        `${await purchaseToken.symbol()} balance:`,
        ethers.formatUnits(
          await purchaseToken.balanceOf(wallet.address),
          await purchaseToken.decimals()
        )
      )
      if (stopAfterFirstTx && !PARAMS.antiRugPull && !sellOnPercentageGain)
        process.exit(0)
      else roundsToBuy = PARAMS.roundsToBuy

      pauseSearch = false
    }
  })
  return txObjects.length
}

const main = async () => {
  // Log("main Transaction:", await provider.getTransactionCount(wallet.address))

  const sendTrans = async () => {
    // Random gasLimit

    if (NETWORK_DATA) {
      Log(
        'Balance:',
        ethers.formatEther(await provider.getBalance(wallet.address)),
        WSYMB.slice(1)
      )
      Log(
        'Contract balance:',
        buyBot.target,
        ethers.formatEther(await WETH.balanceOf(buyBot.target)),
        WSYMB,
        '\n'
      )

      autoMagicLiquidityTokens = await formatLiquidityTokenParams(
        autoMagicLiquidityTokens
      )
      if (!['Follow Wallets', 'Auto-Magic'].includes(mode)) {
        ;({ liquidityToken, minimumLiquidity, maximumLiquidity } =
          await updateLiquidityToken(
            PARAMS.liquidityToken,
            PARAMS.minimumLiquidity,
            0
          ))
      }

      if (PARAMS.preApprove) {
        // TODO NOT TESTED
        switch (mode) {
          case 'Instant Sell': {
            await executeApprove(
              PARAMS.privatekeys,
              sellToken.target,
              buyBot.target
            )
            break
          }
        }
      } else if (
        !['Auto-Magic', 'Instant Sell', 'Follow Wallets'].includes(mode)
      ) {
        ;({ purchaseToken, tokenBuyAmount, realBuyMethod } =
          await updatePurchaseToken(
            PARAMS.purchaseToken,
            PARAMS.tokenBuyAmount,
            PARAMS.realBuyMethod
          ))
      }

      if (
        [
          'Fairlaunch',
          'Pinksale',
          'Follow Dev Wallet (MethodID)',
          'Instant Buy'
        ].includes(mode)
      ) {
        await updateBuyTx(0)
      }

      if (['Instant Sell'].includes(mode)) {
        let sellPercentage = PARAMS.sellPercentage
          ? ethers.parseEther(String(PARAMS.sellPercentage / 100))
          : 0
        let sellAmount = PARAMS.sellAmount
          ? ethers.parseUnits(
              String(PARAMS.sellAmount),
              await sellToken.decimals()
            )
          : 0

        // Log(sellToken, liquidityToken)
        secondStageTx = await generateRugPullTx(
          buyBot,
          NETWORK_DATA.router,
          sellToken.target,
          liquidityToken.target,
          recipients,
          [sellPercentage, sellAmount]
        )
        stopAfterFirstTx = true
      }

      if (mode == 'Approve') {
        pauseSearch = true
        let approveTo
        if (PARAMS.TradeWithContract == true) {
          approveTo = PARAMS.approveTo
          if (approveTo == 'router') approveTo = router.address
          else if (approveTo == 'contract') approveTo = buyBot.target
        } else {
          approveTo = NETWORK_DATA.router
        }
        await executeApprove(
          PARAMS.privatekeys,
          purchaseToken.target,
          approveTo,
          true
        )
      }

      const shouldRun = async tx => {
        let maxFee

        if (tx.gasPrice) {
          maxFee = tx.gasPrice
        } else if (tx.maxFeePerGas) {
          maxFee = tx.maxFeePerGas
        } else {
          const feeData = await provider.getFeeData()
          maxFee = feeData.maxFeePerGas ?? feeData.gasPrice
        }

        if (!maxFee) {
          throw new Error('Unable to determine gas price or max fee')
        }

        const maxFeeGwei = Number(ethers.formatUnits(maxFee, 'gwei'))
        console.log(`Current Max Gwei: ${maxFeeGwei}`)

        return PARAMS.Max_Gwei > maxFeeGwei
      }

      const executeBuy = async (out, round, index) => {
        const randsGasLimit = PARAMS.randomGasLimit
        const randomGasLimit = getRandomNumber(
          randsGasLimit[0],
          randsGasLimit[1]
        ).toFixed(0)
        // Use Random PriorityGas
        const randsPriorityGas = PARAMS.randomPriorityGas
        const randomPriorityGas = getRandomNumber(
          randsPriorityGas[0],
          randsPriorityGas[1]
        ).toFixed(1)

        const randomPriorityGasFormated = randomPriorityGas
          ? ethers.parseUnits(String(randomPriorityGas), 9)
          : null

        // Use Random RealBuyGas
        const randsRealBuyGas = PARAMS.randomRealBuyGas
        const randomRealBuyGas = getRandomNumber(
          randsRealBuyGas[0],
          randsRealBuyGas[1]
        ).toFixed(0)

        const randomRealBuyGasFormated = randomRealBuyGas
          ? ethers.parseUnits(String(randomRealBuyGas), 9)
          : null

        let txOptions = {
          gasLimit: PARAMS.useRandomGas ? randomGasLimit : PARAMS.gasLimit
        }
        if (PARAMS.autoGas == true) initTxGas(txOptions, out)
        else {
          console.log('OUT:', out)
          if (out.IS_EIP1559 || IS_EIP1559_AVAILABLE) {
            // txOptions.maxPriorityFeePerGas = priorityGas;
            txOptions.maxPriorityFeePerGas = PARAMS.useRandomGas
              ? randomPriorityGasFormated
              : priorityGas
          } else {
            txOptions.maxPriorityFeePerGas = PARAMS.useRandomGas
              ? randomPriorityGasFormated
              : priorityGas
            txOptions.gasPrice = PARAMS.useRandomGas
              ? randomRealBuyGasFormated
              : realBuyGas
          }
        }

        // console.log("TX_OPT INIT:", txOptions)

        Log('Sending the transaction...')
        // pasting slice's MaxGwei
        // for (var i = 0; i < rawTx.length; i++) {
        if (PARAMS.useFlashBots) {
          try {
            const fwallet = new ethers.Wallet(
              PARAMS.privatekeys[index],
              provider
            )
            let tx
            if(!PARAMS.useFlashBotsBundles){
              tx = await sendTransactionsViaFlashbots(
                IS_EIP1559_AVAILABLE,
                provider,
                fwallet,
                PARAMS.TradeWithContract
                  ? NETWORK_DATA.contract
                  : NETWORK_DATA.router
              )
            }else{
              tx = await sendTransactionsViaFlashbotsBundle(
                IS_EIP1559_AVAILABLE,
                provider,
                PARAMS.TradeWithContract
                  ? NETWORK_DATA.contract
                  : NETWORK_DATA.router
              )
            }
            if (tx && tx.txHash) {
              const bRun = await shouldRun(tx)
              if (0 == bRun) {
                Log('BUY TRANSACTION exceeds MAX GWEI')
                return
              }

              Log(
                `SENT BUY TRANSACTION USING FlashBots FROM ${fwallet.address} : `,
                constructTxUrlget(tx.txHash)
              )

              // TODO move to own
              let data = JSON.parse(String(fs.readFileSync(cachePath)))
              if (data.winnerNode == null || data.winnerNode == nodeID) {
                data.winnerNode = nodeID
                fs.writeFileSync(cachePath, JSON.stringify(data))
                await pushTxObject(round, tx)
              }
            } else {
              Log(`Failed sending transaction USING FlashBots...`)
              globalFailed += 1
              await pushTxObject(round, 'EXECUTED')
            }
          } catch (e) {
            if(e.action === 'estimateGas'){
              Log("Not enough balance, please check the wallet...")
            }else{
              Log('sendTransactionsViaFlashbots Error=>', e)
              getTxFailReasonLite(e)
              globalFailed += 1
              await pushTxObject(round, 'EXECUTED')
            }
          }
        } else {
          await executeBuyTransaction(
            rawTx[index],
            out,
            new ethers.Wallet(PARAMS.privatekeys[index], provider),
            PARAMS.TradeWithContract
              ? NETWORK_DATA.contract
              : NETWORK_DATA.router,
            round
          )
        }

        // }
      }

      // add by Nathan
      const executeBuyTransaction = async (
        _rawTx,
        _out,
        _wallet,
        _to,
        _round
      ) => {
        try {
          const tx = await _wallet.sendTransaction({
            ...initTxGas(_rawTx.tx, _out),
            nonce: await _wallet.getNonce()
          })
          const bRun = await shouldRun(tx)
          if (0 == bRun) {
            Log('BUY TRANSACTION exceeds MAX GWEI')
            return
          }
          Log(
            `SENT BUY TRANSACTION FROM ${_wallet.address} : `,
            constructTxUrl(tx)
          )

          // TODO move to own
          let data = JSON.parse(String(fs.readFileSync(cachePath)))
          if (data.winnerNode == null || data.winnerNode == nodeID) {
            data.winnerNode = nodeID
            fs.writeFileSync(cachePath, JSON.stringify(data))
            await pushTxObject(_round, tx)
          }
        } catch (e) {
          console.error('Error sending buy transaction:', e.code)

          getTxFailReasonLite(e)
          globalFailed += 1
          await pushTxObject(_round, 'EXECUTED')
        }
      }
      // end by Nathan

      // add by Nathan
      const executeApproveAfterBuy = async () => {
        //Wadi approve hack
        if (
          PARAMS.antiRugPull ||
          PARAMS.sellOnPercentageGain ||
          PARAMS.sellApprove
        ) {
          inSecondStage = true
          await executeApprove(
            PARAMS.privatekeys,
            purchaseToken.target,
            PARAMS.TradeWithContract
              ? NETWORK_DATA.contract
              : NETWORK_DATA.router
          )
          await updateSecondStageTx()
        }
        // End wadi approve hack
      }
      // end by Nathan

      // pasting slice's autogas code
      const initTxGas = (tx, out) => {
        const randsGasLimit = PARAMS.randomGasLimit
        const randomGasLimit = getRandomNumber(
          randsGasLimit[0],
          randsGasLimit[1]
        ).toFixed(0)
        // Use Random PriorityGas
        const randsPriorityGas = PARAMS.randomPriorityGas
        const randomPriorityGas = getRandomNumber(
          randsPriorityGas[0],
          randsPriorityGas[1]
        ).toFixed(1)

        const randomPriorityGasFormated = randomPriorityGas
          ? ethers.parseUnits(String(randomPriorityGas), 9)
          : null
        // Use Random RealBuyGas
        const randsRealBuyGas = PARAMS.randomRealBuyGas
        const randomRealBuyGas = getRandomNumber(
          randsRealBuyGas[0],
          randsRealBuyGas[1]
        ).toFixed(0)

        const randomRealBuyGasFormated = randomRealBuyGas
          ? ethers.parseUnits(String(randomRealBuyGas), 9)
          : null

        if (PARAMS.autoGas) {
          if (out.IS_EIP1559) {
            tx.maxFeePerGas = out.maxFeePerGas
          } else {
            tx.maxFeePerGas = out.maxFeePerGas
          }
          // tx.maxPriorityFeePerGas = out.maxPriorityFeePerGas;
        } else {
          tx.maxPriorityFeePerGas = PARAMS.useRandomGas
            ? randomPriorityGasFormated
            : priorityGas
          tx.maxFeePerGas = PARAMS.useRandomGas
            ? randomRealBuyGasFormated
            : realBuyGas
        }
        tx.gasLimit = PARAMS.useRandomGas ? randomGasLimit : PARAMS.gasLimit
        return tx
      }
      // end of paste slice's autogas code

      // wadi disabled original autogas code coz it wasn't working.
      /*
  const initTxGas = (tx, out) => {
    if (out.IS_EIP1559) {
      tx.maxFeePerGas = out.maxFeePerGas
      tx.maxPriorityFeePerGas = out.maxPriorityFeePerGas
    } else tx.gasPrice = out.gasPrice
    tx.gasLimit = PARAMS.gasLimit
    return tx
  }
*/
      const executeSell = async out => {
        var promises = []
        for (var i = 0; i < secondStageTx.length; i++) {
          promises.push(executeSellTransaction(secondStageTx[i], out, i))
        }
        await Promise.all(promises)
      }

      const executeSellTransaction = async (_rawTxx, out, index) => {
        const randsGasLimit = PARAMS.randomGasLimit
        const randomGasLimit = getRandomNumber(
          randsGasLimit[0],
          randsGasLimit[1]
        ).toFixed(0)

        // Use Random RealBuyGas
        const randsRealBuyGas = PARAMS.randomRealBuyGas
        const randomRealBuyGas = getRandomNumber(
          randsRealBuyGas[0],
          randsRealBuyGas[1]
        ).toFixed(0)

        try {
          let _rawTx = _rawTxx
          _rawTx.gasLimit = PARAMS.useRandomGas
            ? randomGasLimit
            : PARAMS.gasLimit
          // wadi added
          _rawTx.maxFeePerGas = Math.ceil(
            PARAMS.useRandomGas
              ? randomRealBuyGas
              : PARAMS.realBuyGas * PARAMS.gasMultiplier * 1000000000
          )
          // _rawTx.maxPriorityFeePerGas = Math.ceil(
          //   PARAMS.priorityGas * PARAMS.gasMultiplier * 1000000000
          // );

          // End wadi code
          if (out) _rawTx = initTxGas(_rawTxx, out)
          // checking max gwei Keith
          const bRun = await shouldRun(_rawTx)
          if (0 == bRun) {
            Log('SELL TRANSACTION exceeds MAX GWEI')
            return
          }
          // end of paste Keith

          var _wallet = new ethers.Wallet(
            PARAMS.privatekeys[index],
            wallet.provider
          )
          // Log(`Provider in use is: `)
          // Log(_wallet.provider)
          let tx = await _wallet.sendTransaction(_rawTx)
          Log(
            `SENT SELL TRANSACTION FROM ${_wallet.address}: `,
            constructTxUrl(tx)
          )
          await tx.wait()
          Log('Transaction SUCCESSFUL!')
          return tx
        } catch (err) {
          Log(`executeSellTransaction Transaction FAILED=>`)
        }
      }
      _executeSell = executeSell

      continuousBuyExecute = async (out, maxRounds, delay, round = 0) => {
        // if (rawTx.round == round) await executeBuy(out, round);
        // else {
        //   Log(rawTx, round);
        //   Log("Cached `round` does not match actual `round` Exiting...");
        //   process.exit(1);
        // }
        {
          // for (var i = 0; i < rawTx.length; i++) {
          //   if (rawTx[i].round == round) {
          //     executeBuy(out, round, i);
          //   } else {
          //     Log(rawTx[i], round);
          //     Log("Cache `round` does not match actual `round` Exiting...");
          //     process.exit(1);
          //   }
          // }
          if (rawTx[0].round == round) {
            promises = []
            for (var i = 0; i < rawTx.length; i++) {
              promises.push(executeBuy(out, round, i))
            }
            await Promise.all(promises)
            if (PARAMS.sellApprove && !PARAMS.useFlashBots) {
              await executeApproveAfterBuy()
            }
          } else {
            Log(rawTx[0], round)
            Log('Cached `round` does not match actual `round` Exiting...')
            process.exit(1)
          }
        }
        round++

        if (out.gasPrice) lastGasPrice = out.gasPrice
        if (out.maxFeePerGas) lastGasPrice = out.maxFeePerGas
        if (round != maxRounds) {
          setTimeout(
            () => continuousBuyExecute(out, maxRounds, delay, round),
            delay
          )
          await updateBuyTx(round)
        }
      }

      let sellRetries = 0
      const checkCriteriaAndExecute = async (criteria, transaction) => {
        if (pauseSearch) return
        let out = await criteria(transaction, args)
        if (!out || pauseSearch) return
        pauseSearch = true
        //Log(out)

        firstTxCaught = true
        let tokensChanged = false
        if (out.hash) Log(`Triggered by: ${constructTxUrl(out)}`)
        if (out.followed) {
          followed = out.followed
          args.followed = followed
        }
        if (!liquidityToken.target && out.liquidityToken) {
          ;({ liquidityToken, minimumLiquidity, maximumLiquidity } =
            await updateLiquidityToken(
              out.liquidityToken,
              PARAMS.minimumLiquidity,
              0
            ))
          args.liquidityTokenAddress = liquidityToken.target
          tokensChanged = true
        }
        if (out.purchaseToken && !purchaseToken.target) {
          ;({ purchaseToken, tokenBuyAmount, realBuyMethod } =
            await updatePurchaseToken(
              out.purchaseToken,
              tokenBuyAmount,
              realBuyMethod
            ))
          args.purchaseTokenAddress = purchaseToken.target
          tokensChanged = true
        }
        if (tokensChanged) await updateBuyTx(0)
        if (out.devWalletAddress) {
          devWalletAddress = out.devWalletAddress
          args.devWalletAddress = devWalletAddress
        }

        if (PARAMS.blocksDelayBeforeFirstBuy > 0) {
          txByBlock[currentBlock + PARAMS.blocksDelayBeforeFirstBuy] = out
          Log(
            'Buy scheduled for block',
            currentBlock + PARAMS.blocksDelayBeforeFirstBuy
          )
          return
        }
        const gainDetected =
          detectGainsNowOn && out.gain && out.token != previousToken

        const rugPullDetected = detectRugPullNowOn && out.rugPull
        const followSellDetected = detectFollowSellNowOn && out.followSell
        const devActionSell = out.devActionSell
        if (
          gainDetected ||
          rugPullDetected ||
          followSellDetected ||
          devActionSell
        ) {
          try {
            if (mode == 'Follow Dev Wallet (MethodID)')
              await updateSecondStageTx()

            if (rugPullDetected && mode != 'Instant Sell')
              Log('RUG-PULL DETECTED:', constructTxUrl(out))
            if (followSellDetected)
              Log('SELL FROM FOLLOWED WALLET:', constructTxUrl(out))

            await executeSell(out)
            detectGainsNowOn =
              detectRugPullNowOn =
              detectFollowSellNowOn =
                false

            if (PARAMS.stopAfterFirstTx) process.exit()
            previousToken = out.token
            if (!['Instant Sell'].includes(mode)) resetForAutoMagic()
          } catch (e) {
            getTxFailReasonLite(e)
            if (sellRetries >= retryRounds) {
              Log('Sell retries exhausted! Exiting...')
              process.exit()
            } else sellRetries++
            pauseSearch = false
            if (['Instant Sell'].includes(mode)) {
              console.log('Sell failed!')
              process.exit()
            }
            Log('Listening for trigger...')
          }
        } else {
          Log(
            `Starting buys after ${waitBeforeFirstBuy / 1000}s with ${
              delayBetweenBuys / 1000
            }s delay between rounds for ${roundsToBuy} round(s)...`
          )

          lastOut = out
          setTimeout(
            () => continuousBuyExecute(out, roundsToBuy, delayBetweenBuys, 0),
            waitBeforeFirstBuy
          )
        }
      }

      let instantDone = false
      init = () => {
        provider.on('pending', async tx => {
          // Sync with master node
          let data = JSON.parse(String(fs.readFileSync(cachePath)))
          if (
            data.winnerNode != null &&
            (data.winnerNode != nodeID || data.exit)
          ) {
            Log('Exiting as commanded by master node...')
            process.exit(0)
          }
          if (pauseSearch || instantDone) return
          let transaction = await provider.getTransaction(tx)
          if (!transaction) return

          if (!args.init)
            args = {
              init: true,
              walletAddress: wallet.address,
              wallet,
              Log,
              ABI_SYMB,
              uniswapV2R2Decoder,
              wethAddress: WETH.target,
              routerAddress: NETWORK_DATA.router,
              useAutoMagicFor: PARAMS.useAutoMagicFor,
              purchaseTokenAddress: purchaseToken.target,
              autoMagicLiquidityTokens,
              liquidityTokenAddress: liquidityToken.target,
              devWalletAddress,
              devActionIds: PARAMS.devActionIds,
              devAction: PARAMS.devAction,
              devActionIgnoreIds: PARAMS.devActionIgnoreIds,
              toxicIds: PARAMS.toxicIds,
              nonToxicIds: PARAMS.nonToxicIds,
              listingIds: PARAMS.listingIds,
              minimumLiquidity,
              maximumLiquidity,
              gasAction: PARAMS.gasAction,
              gasMultiplier: required(PARAMS.gasMultiplier, 'gasMultiplier'),
              router,
              sellOnPercentageGain,
              priceAtBuy,
              provider,
              followActionTokens: NETWORK_DATA.followActionTokens,
              followWallets: NETWORK_DATA.followWallets,
              followed: followed,
              followMaxGas,
              purchaseTokenBalance: purchaseTokenBalance,
              balanceCheckMultiplier,
              sellThresholdFall
            }
          if (
            !IS_EIP1559_AVAILABLE &&
            transaction &&
            transaction.maxFeePerGas
          ) {
            IS_EIP1559_AVAILABLE = true
            Log('Turning on EIP-1559 Mode.')
          }
          if (stopAfterFirstTx && firstTxCaught && !PARAMS.sellOnPercentageGain)
            return
          if (detectGainsNowOn || detectRugPullNowOn || detectFollowSellNowOn) {
            if (detectFollowSellNowOn)
              await checkCriteriaAndExecute(checkFollowWalletSell, transaction)
            if (PARAMS.antiRugPull && detectRugPullNowOn)
              await checkCriteriaAndExecute(checkRugPullTx, transaction)
            if (sellOnPercentageGain && detectGainsNowOn)
              await checkCriteriaAndExecute(checkPercentageGains, transaction)
          }

          if (!inSecondStage) {
            switch (mode) {
              case 'Fairlaunch': {
                await checkCriteriaAndExecute(checkLiquidityAddTx, transaction)
                break
              }
              case 'Pinksale': {
                await checkCriteriaAndExecute(checkPinksale, transaction)
                break
              }
              case 'Follow Dev Wallet (MethodID)': {
                await checkCriteriaAndExecute(checkDevAction, transaction)
                break
              }
              case 'Auto-Magic': {
                await checkCriteriaAndExecute(checkAutoMagicTxV2, transaction)
                break
              }
              case 'Follow Wallets': {
                await checkCriteriaAndExecute(checkFollowWallet, transaction)
                break
              }
              case 'Instant Buy': {
                await checkCriteriaAndExecute(() => {
                  return { valid: true }
                }, transaction)
                break
              }
              case 'Instant Sell': {
                detectRugPullNowOn = true
                await checkCriteriaAndExecute(() => {
                  return { valid: true, rugPull: true }
                }, transaction)
                break
              }
            }
          }
        })

        provider.on('block', blockNumber => {
          currentBlock = blockNumber
          if (txByBlock[blockNumber]) {
            Log('Executing scheduled buy at block', blockNumber, '...')
            continuousBuyExecute(
              txByBlock[blockNumber],
              roundsToBuy,
              delayBetweenBuys,
              0
            )
          }
        })

        provider.websocket.on('open', () => Log('Websocket listener started'))

        // provider._websocket.on("error", async (err) => {
        //   Log(`${ err }: Unable to connect, retrying in 3s...`)
        //   setTimeout(init, 3000)
        // })
        provider.websocket.on('close', async code => {
          Log(
            `Connection lost with code ${code} !Attempting reconnect in 3s...`
          )
          // TODO fix exit on error
          provider.websocket.terminate()
          setTimeout(init, 3000)
        })
      }
      init()
    }
  }

  sendTrans()
}
main()

process.stdin.on('keypress', async (str, key) => {
  switch (key.sequence) {
    case '\x03':
      Log('Ctrl-C, exit!')
      let data = JSON.parse(String(fs.readFileSync(cachePath)))
      data.exit = true
      fs.writeFileSync(cachePath, JSON.stringify(data))
      process.exit()
    case '\x0E':
      Log('Sell hotkey detected!')
      if (['Auto-Magic', 'Follow Dev Wallet (MethodID)'].includes(mode)) {
        Log('Setting by default params')
        ;({ purchaseToken, tokenBuyAmount, realBuyMethod } =
          await updatePurchaseToken(
            PARAMS.purchaseToken,
            PARAMS.tokenBuyAmount,
            PARAMS.realBuyMethod
          ))
        ;({ liquidityToken, minimumLiquidity, maximumLiquidity } =
          await updateLiquidityToken(
            PARAMS.liquidityToken,
            PARAMS.minimumLiquidity,
            0
          ))
      } else if (!purchaseToken.target || !liquidityToken.target) {
        Log('Wait till a token-pair is updated and approved!')
        return
      }
      try {
        pauseSearch = true
        await updateSecondStageTx()
        await _executeSell()
        if (PARAMS.stopAfterFirstTx) process.exit()
        else {
          resetForAutoMagic()
          pauseSearch = false
        }
      } catch (e) {
        if (PARAMS.stopAfterFirstTx) {
          Log('Transaction FAILED!')
          process.exit()
        } else {
          resetForAutoMagic()
          pauseSearch = false
        }
      }
  }
})
