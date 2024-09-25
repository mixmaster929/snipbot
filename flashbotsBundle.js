const { ethers } = require('ethers')
const {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution
} = require('@flashbots/ethers-provider-bundle')
const fs = require('fs')
const path = require('path')
const PARAMS = require('./params.json')
const NETWORK_DATA = require('./networkData.json')
const { required, ERC20_ABI } = require('./scripts/utils.js')
const { constructTxUrlget } = require('./scripts/utils')
const { initLogger, Log, LogFatalException } = require('./scripts/logger')

const NETWORKDATA = NETWORK_DATA[required(PARAMS.network, 'network')]
const abiPath = path.join(__dirname, 'abi', NETWORKDATA.abitest)
const contractABI = JSON.parse(fs.readFileSync(abiPath, 'utf8'))

const MINIMUM_BALANCE = ethers.parseEther(
  String(required(PARAMS.wethSellAmount, 'wethSellAmount'))
)
const MAX_ATTEMPTS = 100 // Configurable max attempts

async function approveToken (wallet, tokenAddress, spenderAddress, amount) {
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet)
  const tokenSymbol = await tokenContract.symbol()

  const tokenBalance = await tokenContract.balanceOf(wallet.address)
  Log(
    `Token balance: ${ethers.formatUnits(
      tokenBalance,
      await tokenContract.decimals()
    )}`
  )
  //token selling...
  // if (tokenBalance < MINIMUM_BALANCE) {
  //   console.log("Insufficient token balance for swap");
  //   return;
  // }

  Log(
    `Approving ${tokenSymbol}: From ${wallet.address} -> To ${spenderAddress}...`
  )

  const currentAllowance = await tokenContract.allowance(
    wallet.address,
    spenderAddress
  )

  Log(`Allowance: ${ethers.formatEther(currentAllowance)} tokens`)

  if (currentAllowance >= amount) {
    Log(`Token ${tokenSymbol} already approved for ${spenderAddress}.`)
    return true
  }

  try {
    const approveTx = await tokenContract.approve(spenderAddress, amount)
    await approveTx.wait()
    Log(`${tokenSymbol} approved successfully!`)
    return true
  } catch (error) {
    Log(`Error approving ${tokenSymbol} on Flashbots:`, error)
    return false
  }
}

async function getChainId (provider) {
  const network = await provider.getNetwork()
  return network.chainId
}

async function getCurrentGasFee (provider) {
  try {
    const feeData = await provider.getFeeData()
    const block = await provider.getBlock('latest')
    const currentBaseFee = block.baseFeePerGas

    // let maxFeePerGas = feeData.maxFeePerGas * 2n
    // const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 2n

    // const minMaxFeePerGas = (currentBaseFee * 110n) / 100n
    // maxFeePerGas =
    //   maxFeePerGas > minMaxFeePerGas ? maxFeePerGas : minMaxFeePerGas

    // Increase the multiplier to account for potential base fee increases
    const baseFeeMulitplier = 120n // 120% of current base fee
    const priorityFeeMulitplier = 3n // 3x the suggested priority fee

    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas * priorityFeeMulitplier
    const maxFeePerGas =
      (currentBaseFee * baseFeeMulitplier) / 100n + maxPriorityFeePerGas

    const gasPrice = feeData.gasPrice

    return { maxFeePerGas, maxPriorityFeePerGas, gasPrice }
  } catch (error) {
    Log('Error fetching gas fee on Flashbots:', error)
    throw error
  }
}

async function sendTransactionsViaFlashbotsBundle (
  IS_EIP1559_AVAILABLE,
  provider,
  routerContractAddress
) {
  const wallets = PARAMS.privatekeys.map(
    key => new ethers.Wallet(key, provider)
  )

  try {
    
    const randomWallet = ethers.Wallet.createRandom()

    const flashbotsProvider = await FlashbotsBundleProvider.create(
      provider,
      randomWallet,
      NETWORKDATA.flashBotsRPC,
      'sepolia'
    )

    const contract = new ethers.Contract(
      routerContractAddress,
      contractABI,
      provider
    )
    let transaction
    const path = [PARAMS.liquidityToken, PARAMS.purchaseToken]
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from now
    const amountOutMin = (MINIMUM_BALANCE * 95n) / 100n // 5% slippage tolerance
    const balances = await Promise.all(
      wallets.map(async wallet => {
        const data = contract.interface.encodeFunctionData(
          'swapExactETHForTokensSupportingFeeOnTransferTokens',
          [amountOutMin, path, wallet.address, deadline]
        )

        const currentGasFees = await getCurrentGasFee(provider)
        const chainId = await getChainId(provider)
        const nonce = await wallet.getNonce()

        const legacyTransaction = {
          to: routerContractAddress,
          gasPrice: currentGasFees.gasPrice,
          data: data,
          value: MINIMUM_BALANCE,
          nonce: nonce,
          chainId: chainId,
          type: 0
        }

        const eip1559Transaction = {
          chainId,
          type: 2,
          to: routerContractAddress,
          data,
          value: MINIMUM_BALANCE,
          maxFeePerGas: currentGasFees.maxFeePerGas,
          maxPriorityFeePerGas: currentGasFees.maxPriorityFeePerGas
        }
        transaction = IS_EIP1559_AVAILABLE
          ? eip1559Transaction
          : legacyTransaction

        const ethBalance = await provider.getBalance(wallet.address)
        if (ethBalance < MINIMUM_BALANCE * 2n) {
          Log(
            `Wallet ${wallet.address} does not have enough balance. Skipping...`
          )
        }
        Log(
          `Wallet ${wallet.address} has balance: ${ethers.formatEther(
            ethBalance
          )} ETH`
        )
        // const tokenBalance = await tokenContract.balanceOf(wallet.address); // Check token balance
        return {
          wallet: wallet,
          ethBalance: ethers.formatEther(ethBalance) // Convert to human-readable format (ETH)
          // tokenBalance: ethers.formatUnits(tokenBalance, await tokenContract.decimals()) // Assuming 18 decimals for token
        }
      })
    )

    const walletsWithEnoughBalance = balances.filter(balance => {
      return ethers.parseEther(balance.ethBalance) >= MINIMUM_BALANCE
      // &&ethers.parseUnits(balance.tokenBalance, 18).gte(minTokenAmount);
    })

    const txs = await Promise.all(
      walletsWithEnoughBalance.map(async wallet => {
        if (PARAMS.sellApprove) {
          // Approve the token before attempting the swap
          const approvalSuccess = await approveToken(
            wallet.wallet,
            PARAMS.purchaseToken,
            routerContractAddress,
            MINIMUM_BALANCE
          )
    
          if (!approvalSuccess) {
            Log('Token approval failed. Skipping the transaction.')
            return
          }
        }
        return { signer: wallet.wallet, transaction: transaction }
      })
    )
    
    const bundle = txs.map(({ signer, transaction }) => ({
      signer,
      transaction
    }))

    const signedBundle = await flashbotsProvider.signBundle(bundle)

    let targetBlockNumber = await provider.getBlockNumber()
    const simulation = await flashbotsProvider.simulate(
      signedBundle,
      targetBlockNumber + 1
    )

    let tx
    if ('error' in simulation) {
      Log(`Simulation error: ${simulation.error.message}`)
      return simulation.error.message
    } else {
      // console.log(JSON.stringify(simulation, (key, value) =>
      //       typeof value === 'bigint'
      //           ? value.toString()
      //           : value,
      //       2
      //   ));
      tx = simulation.results[0]
      const simulationStatus = simulation.results[0].error
      if (!simulationStatus) {
        Log('Simulation successful. Proceeding with bundle submission.')
        // Log(
        //   `Sending the transaction using useFlashBots... ${constructTxUrlget(
        //     tx.txHash
        //   )}`
        // )
      } else {
        Log(`Simulation internal error: ${simulationStatus}`)
        return simulationStatus
      }
    }

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      targetBlockNumber = await provider.getBlockNumber()
      const flashbotsTransactionResponse =
        await flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber + 1
        )

      if ('error' in flashbotsTransactionResponse) {
        Log(
          `Error in attempt ${i}:`,
          flashbotsTransactionResponse.error.message
        )
        continue
      }

      const resolution = await flashbotsTransactionResponse.wait()

      if (resolution === FlashbotsBundleResolution.BundleIncluded) {
        Log(`Success! Bundle included in block ${targetBlockNumber + 1}`)
        return tx
      } else if (
        resolution === FlashbotsBundleResolution.BlockPassedWithoutInclusion
      ) {
        Log(
          `Bundle not included in block ${targetBlockNumber + 1}. Retrying...`
        )
      } else if (resolution === FlashbotsBundleResolution.AccountNonceTooHigh) {
        Log('Nonce too high. Stopping execution.')
        return false
      }
    }

    Log(`Bundle not included after ${MAX_ATTEMPTS} attempts.`)
  } catch (error) {
    if (error.message.includes('ALREADY_EXISTS')) {
      Log('Transaction already submitted. Skipping...')
    } else {
      throw error
    }
  }
}

module.exports = {
  sendTransactionsViaFlashbotsBundle
}
