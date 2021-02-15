import BN from 'bn.js'
import { ether, expectEvent } from '@openzeppelin/test-helpers'

import { calculateTransactionMaxPossibleGas, getEip712Signature } from '../src/common/Utils'
import TypedRequestData from '../src/common/EIP712/TypedRequestData'
import { defaultEnvironment } from '../src/common/Environments'
import RelayRequest, { cloneRelayRequest } from '../src/common/EIP712/RelayRequest'

import {
  RelayHubInstance,
  TestRecipientInstance,
  TestPaymasterVariableGasLimitsInstance,
  StakeManagerInstance,
  IForwarderInstance,
  PenalizerInstance
} from '../types/truffle-contracts'
import { calculateCalldataCost, deployHub, revert, snapshot } from './TestUtils'
import { registerForwarderForGsn } from '../src/common/EIP712/ForwarderUtil'
import { toBuffer } from 'ethereumjs-util'

const Forwarder = artifacts.require('Forwarder')
const StakeManager = artifacts.require('StakeManager')
const Penalizer = artifacts.require('Penalizer')
const TestRecipient = artifacts.require('TestRecipient')
const TestPaymasterVariableGasLimits = artifacts.require('TestPaymasterVariableGasLimits')
const TestPaymasterConfigurableMisbehavior = artifacts.require('TestPaymasterConfigurableMisbehavior')

contract('RelayHub gas calculations', function ([_, relayOwner, relayWorker, relayManager, senderAddress, other]) {
  const message = 'Gas Calculations'
  const unstakeDelay = 1000
  const chainId = defaultEnvironment.chainId
  const baseFee = new BN('300')
  const fee = new BN('10')
  const gasPrice = new BN('10')
  const gasLimit = new BN('1000000')
  const externalGasLimit = 5e6.toString()
  const paymasterData = '0x'
  const clientId = '1'

  const senderNonce = new BN('0')
  const magicNumbers = {
    pre: 5431,
    post: 1595
  }

  let relayHub: RelayHubInstance
  let stakeManager: StakeManagerInstance
  let penalizer: PenalizerInstance
  let recipient: TestRecipientInstance
  let paymaster: TestPaymasterVariableGasLimitsInstance
  let forwarderInstance: IForwarderInstance
  let encodedFunction
  let signature: string
  let relayRequest: RelayRequest
  let forwarder: string
  let hubDataGasCostPerByte: number

  beforeEach(async function prepareForHub () {
    forwarderInstance = await Forwarder.new()
    forwarder = forwarderInstance.address
    recipient = await TestRecipient.new(forwarder)
    paymaster = await TestPaymasterVariableGasLimits.new()
    stakeManager = await StakeManager.new(defaultEnvironment.maxUnstakeDelay)
    penalizer = await Penalizer.new(defaultEnvironment.penalizerConfiguration.penalizeBlockDelay, defaultEnvironment.penalizerConfiguration.penalizeBlockExpiration)
    relayHub = await deployHub(stakeManager.address, penalizer.address)
    hubDataGasCostPerByte = (await relayHub.dataGasCostPerByte()).toNumber()
    await paymaster.setTrustedForwarder(forwarder)
    await paymaster.setRelayHub(relayHub.address)
    // register hub's RelayRequest with forwarder, if not already done.
    await registerForwarderForGsn(forwarderInstance)

    await relayHub.depositFor(paymaster.address, {
      value: ether('1'),
      from: other
    })

    await stakeManager.setRelayManagerOwner(relayOwner, { from: relayManager })
    await stakeManager.stakeForRelayManager(relayManager, unstakeDelay, {
      value: ether('2'),
      from: relayOwner
    })
    await stakeManager.authorizeHubByOwner(relayManager, relayHub.address, { from: relayOwner })
    await relayHub.addRelayWorkers([relayWorker], { from: relayManager })
    await relayHub.registerRelayServer(0, fee, '', { from: relayManager })
    encodedFunction = recipient.contract.methods.emitMessage(message).encodeABI()
    relayRequest = {
      request: {
        to: recipient.address,
        data: encodedFunction,
        from: senderAddress,
        nonce: senderNonce.toString(),
        value: '0',
        gas: gasLimit.toString(),
        validUntil: '0'
      },
      relayData: {
        baseRelayFee: baseFee.toString(),
        pctRelayFee: fee.toString(),
        gasPrice: gasPrice.toString(),
        relayWorker,
        forwarder,
        paymaster: paymaster.address,
        paymasterData,
        clientId
      }

    }
    const dataToSign = new TypedRequestData(
      chainId,
      forwarder,
      relayRequest
    )
    signature = await getEip712Signature(
      web3,
      dataToSign
    )
  })

  describe('#calculateCharge()', function () {
    it('should calculate fee correctly', async function () {
      const gasUsed = 1e8
      const gasPrice = 1e9
      const baseRelayFee = 1000000
      const pctRelayFee = 10
      const relayData = {
        pctRelayFee,
        baseRelayFee,
        gasPrice,
        gasLimit: 0,
        relayWorker,
        forwarder,
        paymaster: paymaster.address,
        paymasterData,
        clientId
      }
      const charge = await relayHub.calculateCharge(gasUsed.toString(), relayData)
      const expectedCharge = baseRelayFee + gasUsed * gasPrice * (pctRelayFee + 100) / 100
      assert.equal(charge.toString(), expectedCharge.toString())
    })
  })

  describe('#relayCall()', function () {
    it('should set correct gas limits and pass correct \'maxPossibleGas\' to the \'preRelayedCall\'',
      async function () {
        const transactionGasLimit = gasLimit.mul(new BN(3))
        const res = await relayHub.relayCall(10e6, relayRequest, signature, '0x', transactionGasLimit, {
          from: relayWorker,
          gas: transactionGasLimit.toString(),
          gasPrice
        })
        const { tx } = res
        const gasAndDataLimits = await paymaster.getGasAndDataLimits()
        const hubOverhead = (await relayHub.gasOverhead()).toNumber()
        const msgDataLength = toBuffer(
          relayHub.contract.methods.relayCall(10e6, relayRequest, signature, '0x', transactionGasLimit.toNumber()).encodeABI()).length
        const msgDataGasCost = hubDataGasCostPerByte * msgDataLength
        const maxPossibleGas = calculateTransactionMaxPossibleGas({
          gasAndDataLimits: gasAndDataLimits,
          hubOverhead,
          relayCallGasLimit: gasLimit.toString(),
          msgDataGasCost
        })

        // Magic numbers seem to be gas spent on calldata. I don't know of a way to calculate them conveniently.
        await expectEvent.inTransaction(tx, TestPaymasterVariableGasLimits, 'SampleRecipientPreCallWithValues', {
          gasleft: (parseInt(gasAndDataLimits.preRelayedCallGasLimit) - magicNumbers.pre).toString(),
          maxPossibleGas: maxPossibleGas.toString()
        })
        await expectEvent.inTransaction(tx, TestPaymasterVariableGasLimits, 'SampleRecipientPostCallWithValues', {
          gasleft: (parseInt(gasAndDataLimits.postRelayedCallGasLimit) - magicNumbers.post).toString()
        })
      })

    // note: since adding the revert reason to the emit, post overhead is dynamic
    it('should set correct gas limits and pass correct \'gasUsedWithoutPost\' to the \'postRelayCall\'', async () => {
      const gasPrice = 1e9
      const estimatePostGas = (await paymaster.postRelayedCall.estimateGas('0x', true, '0x', {
        gasPrice,
        pctRelayFee: 0,
        baseRelayFee: 0,
        relayWorker,
        forwarder,
        paymaster: paymaster.address,
        paymasterData,
        clientId
      }, { from: relayHub.address })) - 21000

      const externalGasLimit = 5e6
      const tx = await relayHub.relayCall(10e6, relayRequest, signature, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit.toString(),
        gasPrice
      })

      const pmlogs = await paymaster.contract.getPastEvents()
      const pmPostLog = pmlogs.find((e: any) => e.event === 'SampleRecipientPostCallWithValues')

      const gasUseWithoutPost = parseInt(pmPostLog.returnValues.gasUseWithoutPost)
      const usedGas = parseInt(tx.receipt.gasUsed)
      assert.closeTo(gasUseWithoutPost, usedGas - estimatePostGas, 100,
        `postOverhead: increase by ${usedGas - estimatePostGas - gasUseWithoutPost}\
        \n\tpostOverhead: ${defaultEnvironment.relayHubConfiguration.postOverhead + usedGas - estimatePostGas - gasUseWithoutPost},\n`
      )
    })

    it('should revert an attempt to use more than allowed gas for preRelayedCall', async function () {
      // TODO: extract preparation to 'before' block
      const misbehavingPaymaster = await TestPaymasterConfigurableMisbehavior.new()
      await misbehavingPaymaster.setTrustedForwarder(forwarder)
      await misbehavingPaymaster.setRelayHub(relayHub.address)
      await misbehavingPaymaster.deposit({ value: ether('0.1') })
      await misbehavingPaymaster.setOutOfGasPre(true)

      const senderNonce = (await forwarderInstance.getNonce(senderAddress)).toString()
      const relayRequestMisbehaving = cloneRelayRequest(relayRequest)
      relayRequestMisbehaving.relayData.paymaster = misbehavingPaymaster.address
      relayRequestMisbehaving.request.nonce = senderNonce
      const dataToSign = new TypedRequestData(
        chainId,
        forwarder,
        relayRequestMisbehaving
      )
      const signature = await getEip712Signature(
        web3,
        dataToSign
      )
      const viewRelayCallResponse =
        await relayHub.contract.methods
          .relayCall(10e6, relayRequestMisbehaving, signature, '0x', externalGasLimit)
          .call({
            from: relayRequestMisbehaving.relayData.relayWorker,
            gas: externalGasLimit
          })
      assert.equal(viewRelayCallResponse[0], false)
      assert.equal(viewRelayCallResponse[1], null) // no revert string on out-of-gas

      const res = await relayHub.relayCall(10e6, relayRequestMisbehaving, signature, '0x', externalGasLimit, {
        from: relayWorker,
        gas: externalGasLimit,
        gasPrice: gasPrice
      })

      assert.equal('TransactionRejectedByPaymaster', res.logs[0].event)
      assert.equal(res.logs[0].args.reason, null)
    })
  })

  async function getBalances (): Promise<{
    paymasters: BN
    relayWorkers: BN
    relayManagers: BN
  }> {
    const paymasters = await relayHub.balanceOf(paymaster.address)
    // @ts-ignore
    const relayWorkers = new BN(await web3.eth.getBalance(relayWorker))
    const relayManagers = await relayHub.balanceOf(relayManager)
    return {
      paymasters,
      relayWorkers,
      relayManagers
    }
  }

  async function diffBalances (startBalances: {
    paymasters: BN
    relayWorkers: BN
    relayManagers: BN
  }):
    Promise<{
      paymasters: BN
      relayWorkers: BN
      relayManagers: BN
    }> {
    const balances = await getBalances()
    return {
      paymasters: startBalances.paymasters.sub(balances.paymasters),
      relayWorkers: startBalances.relayWorkers.sub(balances.relayWorkers),
      relayManagers: startBalances.relayManagers.sub(balances.relayManagers)
    }
  }

  function logOverhead (weiActualCharge: BN, workerGasUsed: BN): void {
    const gasDiff = workerGasUsed.sub(weiActualCharge).div(gasPrice).toString()
    if (gasDiff !== '0') {
      console.log('== zero-fee unmatched gas. RelayHubConfiguration.gasOverhead should be increased by: ' + gasDiff.toString())
      defaultEnvironment.relayHubConfiguration.gasOverhead += parseInt(gasDiff)
      console.log(`=== fixed:\n\tgasOverhead: ${defaultEnvironment.relayHubConfiguration.gasOverhead},\n`)
    }
  }

  context('charge calculation should not depend on return/revert value of request', () => {
    [[true, 0], [true, 20], [false, 0], [false, 50]]
      .forEach(([doRevert, len]) => {
        it(`should calculate overhead regardless of return value len (${len}) or revert (${doRevert})`, async () => {
          const beforeBalances = getBalances()
          const senderNonce = (await forwarderInstance.getNonce(senderAddress)).toString()
          let encodedFunction
          if (len === 0) {
            encodedFunction = recipient.contract.methods.checkNoReturnValues(doRevert).encodeABI()
          } else {
            encodedFunction = recipient.contract.methods.checkReturnValues(len, doRevert).encodeABI()
          }
          const relayRequest: RelayRequest = {
            request: {
              to: recipient.address,
              data: encodedFunction,
              from: senderAddress,
              nonce: senderNonce,
              value: '0',
              gas: gasLimit.toString(),
              validUntil: '0'
            },
            relayData: {
              baseRelayFee: '0',
              pctRelayFee: '0',
              gasPrice: '1',
              relayWorker,
              forwarder,
              paymaster: paymaster.address,
              paymasterData,
              clientId
            }
          }
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequest
          )
          const signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const res = await relayHub.relayCall(10e6, relayRequest, signature, '0x', externalGasLimit, {
            from: relayWorker,
            gas: externalGasLimit,
            gasPrice: gasPrice
          })
          const resultEvent = res.logs.find(e => e.event === 'TransactionResult')
          if (len === 0) {
            assert.equal(resultEvent, null, 'should not get TransactionResult with zero len')
          } else {
            assert.notEqual(resultEvent, null, 'didn\'t get TransactionResult where it should.')
          }
          const gasUsed = res.receipt.gasUsed
          const diff = await diffBalances(await beforeBalances)
          assert.equal(diff.paymasters.toNumber(), gasUsed)
        })
      })
  })

  describe('relayCall()\'s msg.data cost calculations', function () {
    enum RelayCallDynamicArg {
      APPROVAL_DATA = 'approvalData',
      ENCODED_FUNCTION = 'encodedFunction',
      PAYMASTER_DATA = 'paymasterData'
    }

    const costsPerByte: number[] = [];
    [RelayCallDynamicArg.APPROVAL_DATA, RelayCallDynamicArg.ENCODED_FUNCTION, RelayCallDynamicArg.PAYMASTER_DATA].forEach(dynamicArg => {
      const gassesUsed: any[] = [];
      [0, 32, 128, 8192/* , 32768, 65536 */].forEach(dataLength => {
        it(`with arg: ${dynamicArg} length: ${dataLength}`, async function () {
          // console.log('gasUsed: ', gassesUsed)
          const id = (await snapshot()).result
          const senderNonce = (await forwarderInstance.getNonce(senderAddress)).toString()
          let approvalData = '0x'
          let paymasterData = '0x'
          let encodedFunction = recipient.contract.methods.dontEmitMessage('').encodeABI()
          if (dynamicArg === RelayCallDynamicArg.APPROVAL_DATA) {
            approvalData = '0x' + 'ff'.repeat(dataLength)
          } else if (dynamicArg === RelayCallDynamicArg.ENCODED_FUNCTION) {
            encodedFunction = recipient.contract.methods.dontEmitMessage('f'.repeat(dataLength)).encodeABI()
            // console.log('encodedFunction', encodedFunction)
          } else if (dynamicArg === RelayCallDynamicArg.PAYMASTER_DATA) {
            paymasterData = '0x' + 'ff'.repeat(dataLength)
          }
          const relayRequest: RelayRequest = {
            request: {
              to: recipient.address,
              data: encodedFunction,
              from: senderAddress,
              nonce: senderNonce,
              value: '0',
              gas: gasLimit.toString(),
              validUntil: '0'
            },
            relayData: {
              baseRelayFee: '0',
              pctRelayFee: '0',
              gasPrice: '1',
              relayWorker,
              forwarder,
              paymaster: paymaster.address,
              paymasterData,
              clientId
            }
          }
          const dataToSign = new TypedRequestData(
            chainId,
            forwarder,
            relayRequest
          )
          const signature = await getEip712Signature(
            web3,
            dataToSign
          )
          const relayCall = relayHub.contract.methods.relayCall(10e6, relayRequest, signature, approvalData, externalGasLimit)
          const receipt = await relayCall.send({
            from: relayWorker,
            gas: externalGasLimit,
            gasPrice: gasPrice
          })
          gassesUsed.push(receipt.gasUsed - calculateCalldataCost(relayCall.encodeABI()))
          // console.log('relayCall encodeABI len', relayCall.encodeABI().length / 2)
          // console.log('gasUsed is', receipt.gasUsed)
          // console.log('calculateCalldataCost is', calculateCalldataCost(relayCall.encodeABI()))
          const slack = 2
          if (gassesUsed.length > 1) {
            const diff = gassesUsed[gassesUsed.length - 1] - gassesUsed[0]
            // console.log('diff per byte is', diff / dataLength)
            // console.log('diff is', diff)
            const costPerByte = diff / dataLength
            costsPerByte.push(costPerByte)
            assert.isAtMost(costPerByte, hubDataGasCostPerByte - slack, `calculated data cost per byte (${costPerByte}) higher than hub's (${hubDataGasCostPerByte}) minus slack of ${slack}`)
          }
          await revert(id)
        })
      })
    })
    after('validate max gas cost per byte in relay hub', async function () {
      // console.log('costs per byte', costsPerByte)
      const maxCostPerByte = Math.max(...costsPerByte)
      assert.closeTo(hubDataGasCostPerByte, maxCostPerByte, 5)
    })
  })

  describe('check calculation does not break for different fees', function () {
    before(async function () {
      await relayHub.depositFor(relayOwner, { value: (1).toString() })
    });

    [0, 1000]
      .forEach(messageLength =>
        [0, 1, 100]
          .forEach(requestedFee => {
            // avoid duplicate coverage checks. they do the same, and take a lot of time:
            if (requestedFee !== 0 && messageLength !== 0 && process.env.MODE === 'coverage') return
            // 50k tests take more than 10 seconds to complete so will run once for sanity
            if (messageLength === 50000 && requestedFee !== 10) return
            it(`should compensate relay with requested fee of ${requestedFee.toString()}% with ${messageLength.toString()} calldata size`,
              async function () {
                const beforeBalances = await getBalances()
                const pctRelayFee = requestedFee.toString()
                const senderNonce = (await forwarderInstance.getNonce(senderAddress)).toString()
                const encodedFunction = recipient.contract.methods.emitMessage('a'.repeat(messageLength)).encodeABI()
                const baseRelayFee = '0'
                const relayRequest: RelayRequest = {
                  request: {
                    to: recipient.address,
                    data: encodedFunction,
                    from: senderAddress,
                    nonce: senderNonce,
                    value: '0',
                    gas: gasLimit.toString(),
                    validUntil: '0'
                  },
                  relayData: {
                    baseRelayFee,
                    pctRelayFee,
                    gasPrice: gasPrice.toString(),
                    relayWorker,
                    forwarder,
                    paymaster: paymaster.address,
                    paymasterData,
                    clientId
                  }
                }
                const dataToSign = new TypedRequestData(
                  chainId,
                  forwarder,
                  relayRequest
                )
                const signature = await getEip712Signature(
                  web3,
                  dataToSign
                )
                const res = await relayHub.relayCall(10e6, relayRequest, signature, '0x', externalGasLimit, {
                  from: relayWorker,
                  gas: externalGasLimit,
                  gasPrice: gasPrice
                })

                const afterBalances = await getBalances()
                assert.notEqual(beforeBalances.relayManagers.toString(), afterBalances.relayManagers.toString(),
                  'manager not compensated. transaction must have failed')

                // how much we got compensated for this tx from the paymaster
                const weiActualCharge = afterBalances.relayManagers.sub(beforeBalances.relayManagers)

                // how much gas we actually spent on this tx
                const workerWeiGasUsed = beforeBalances.relayWorkers.sub(afterBalances.relayWorkers)

                if (requestedFee === 0) {
                  logOverhead(weiActualCharge, workerWeiGasUsed)
                }

                // sanity: worker executed and paid this tx
                assert.equal((gasPrice.muln(res.receipt.gasUsed)).toString(), workerWeiGasUsed.toString(), 'where else did the money go?')

                const expectedCharge = Math.floor(workerWeiGasUsed.toNumber() * (100 + requestedFee) / 100) + parseInt(baseRelayFee)
                assert.equal(weiActualCharge.toNumber(), expectedCharge,
                  'actual charge from paymaster higher than expected. diff= ' + ((weiActualCharge.toNumber() - expectedCharge) / gasPrice.toNumber()).toString())

                // Validate actual profit is with high precision $(requestedFee) percent higher then ether spent relaying
                // @ts-ignore (this types will be implicitly cast to correct ones in JavaScript)
                const expectedActualCharge = workerWeiGasUsed.mul(new BN(requestedFee).add(new BN(100))).div(new BN(100))
                assert.equal(weiActualCharge.toNumber(), expectedActualCharge.toNumber(),
                  'unexpected over-paying by ' + (weiActualCharge.sub(expectedActualCharge)).toString())
                // Check that relay did pay it's gas fee by himself.
                // @ts-ignore (this types will be implicitly cast to correct ones in JavaScript)
                const expectedBalanceAfter = beforeBalances.relayWorkers.subn(res.receipt.gasUsed * gasPrice)
                assert.equal(expectedBalanceAfter.cmp(afterBalances.relayWorkers), 0, 'relay did not pay the expected gas fees')

                // Check that relay's weiActualCharge is deducted from paymaster's stake.
                // @ts-ignore (this types will be implicitly cast to correct ones in JavaScript)
                const expectedPaymasterBalance = beforeBalances.paymasters.sub(weiActualCharge)
                assert.equal(expectedPaymasterBalance.toString(), afterBalances.paymasters.toString())
              })
          })
      )
  })
})
