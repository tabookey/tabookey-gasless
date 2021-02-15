import BN from 'bn.js'

import { decodeRevertReason, getEip712Signature } from '../src/common/Utils'
import TypedRequestData from '../src/common/EIP712/TypedRequestData'
import { defaultEnvironment } from '../src/common/Environments'
import RelayRequest from '../src/common/EIP712/RelayRequest'

import {
  TestUtilInstance,
  RelayHubInstance,
  TestRecipientInstance
} from '../types/truffle-contracts'
import { calculateCalldataCost, deployHub, revert, snapshot } from './TestUtils'
import { registerForwarderForGsn } from '../src/common/EIP712/ForwarderUtil'

const Forwarder = artifacts.require('Forwarder')
const StakeManager = artifacts.require('StakeManager')
const Penalizer = artifacts.require('Penalizer')
const TestRecipient = artifacts.require('TestRecipient')
const TestPaymasterConfigurableMisbehavior = artifacts.require('TestPaymasterConfigurableMisbehavior')
const TestUtil = artifacts.require('TestUtil')

contract('RelayHub acceptanceBudget calculations', function ([_, relayOwner, relayWorker, relayManager, senderAddress, other]) {
  let recipient: TestRecipientInstance
  let relayHub: RelayHubInstance
  let testUtil: TestUtilInstance

  let forwarder: string
  const gasLimit = new BN('1000000')
  let chainId: number

  let gasPrice: number
  const clientId = '1'
  const externalGasLimit = 5e6.toString()

  const stakeValue = '0'
  const unstakeDelay = 1

  // async binary search
  // look for the highest value (+/- 1) where func returns "true
  // @param min minimum value , where func is known to return false
  // @param max - maximum value, where func is known to return true
  // @param func a function to check a value.
  async function bsearch (min: number, max: number, func: (val: number) => Promise<boolean>): Promise<number> {
    // sanity check inputs: min should return "false", and max should return "true"
    if (min >= max) throw new Error(`max have max:${max} > min:${min}`)
    if (await func(min)) throw new Error(`should return false on minvalue ${min}`)
    if (!(await func(max))) throw new Error(`should return true maxvalue ${max}`)

    // must converge in log2(max-min) attempts
    while (true) {
      if (max - min <= 1) return max
      const mid = Math.trunc((max + min) / 2)
      if (await func(mid)) {
        max = mid
      } else {
        min = mid
      }
    }
  }

  before(async () => {
    const forwarderInstance = await Forwarder.new()
    forwarder = forwarderInstance.address
    recipient = await TestRecipient.new(forwarder)
    const stakeManager = await StakeManager.new(defaultEnvironment.maxUnstakeDelay)
    const penalizer = await Penalizer.new(defaultEnvironment.penalizerConfiguration.penalizeBlockDelay, defaultEnvironment.penalizerConfiguration.penalizeBlockExpiration)
    relayHub = await deployHub(stakeManager.address, penalizer.address, { minimumStake: stakeValue, minimumUnstakeDelay: unstakeDelay })
    testUtil = await TestUtil.new()

    chainId = await testUtil.libGetChainID().then(x => x.toNumber())

    // register hub's RelayRequest with forwarder, if not already done.
    await registerForwarderForGsn(forwarderInstance, { from: _ })

    await stakeManager.setRelayManagerOwner(relayOwner, { from: relayManager })
    await stakeManager.stakeForRelayManager(relayManager, unstakeDelay, {
      value: stakeValue,
      from: relayOwner
    })
    await stakeManager.authorizeHubByOwner(relayManager, relayHub.address, { from: relayOwner })
    await relayHub.addRelayWorkers([relayWorker], { from: relayManager })
    await relayHub.registerRelayServer(0, 0, '', { from: relayManager })
  })
  /*
  this test attempt to revert the test to calculate the gas cost:
  - we have a paymaster with very high preRelayGasLimit, and the TX will fail always on nonce error.
  - we want to calculate the acceptanceBudget required for each data size.
  - acceptanceBudget should be gas-related only, so we try with different data-sizes.
  - to find the acceptanceBudget, we do a bsearch by calling relayCall, and finding when it return TransactionRelayed (AB is high) and when RejectedByPaymaster (AB is low)
  - output is comma-separated so it can relatively easy be imported into "sheets.new" (pbpaste|grep ,|pbcopy)
   */
  describe.only('data gascost', () => {
    // NOTE: the bsearch is VERY slow. better run this test alone...
    [0, 100, 8000, 15000, 20000, 30000].forEach(bufferExtra =>
      it(`test data cost with datasize ${bufferExtra}`, async function () {
        const senderNonce = '12345' // we want to fail on "nonce" error.
        const approvalData = '0x'
        const paymasterData = '0x'
        const encodedFunction = (recipient.contract.methods.dontEmitMessage('').encodeABI() as string) + '00'.repeat(bufferExtra)
        const paymaster = await TestPaymasterConfigurableMisbehavior.new()
        await paymaster.setRelayHub(relayHub.address)
        await paymaster.setTrustedForwarder(forwarder)
        await paymaster.deposit({ value: 1e18.toString() })
        await paymaster.setExpensiveAcceptGas(true)

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

        // in order to reduce the variable part (cost of verify), we calculate it
        const forwarderExecute = testUtil.contract.methods.forwarderExecuteNoRevert(relayRequest, signature)
        const { forwarderSuccess, ret } = await forwarderExecute.call()
        assert.equal(forwarderSuccess, false)
        assert.equal(decodeRevertReason(ret), 'FWD: nonce mismatch')
        const estimForwarderCall = await forwarderExecute.estimateGas()
        const forwarderDataCost = calculateCalldataCost(forwarderExecute.encodeABI())

        // first, normal failure with high acceptanceBudget
        // const ret = await relayHub.relayCall(10e6, relayRequest, signature, approvalData, externalGasLimit, { from: relayWorker, gas: externalGasLimit, gasPrice })
        // const ev: any = ret.logs.find(e => e.event === 'TransactionRejectedByPaymaster')
        // assert.isNotNull(ev, `no RejectedByPaymaster event in ${ret.logs.toString()}`)
        // const innerGasUsed = ev.args.innerGasUsed.toString()
        // console.log('first innerGasUsed', innerGasUsed)
        const encoded = await relayHub.contract.methods.relayCall(10e6, relayRequest, signature, approvalData, externalGasLimit).encodeABI() as string

        async function checkAcceptanceBudget (gas: number): Promise<boolean> {
          const snap = await snapshot()
          await paymaster.setGasLimits(gas, 1e6, 1e6, 100000)
          try {
            const ret = await relayHub.relayCall(10e6, relayRequest, signature, approvalData, externalGasLimit, { from: relayWorker, gas: externalGasLimit, gasPrice })
            const txrej: any = ret.logs.find(e => e.event === 'TransactionRejectedByPaymaster')
            const debug = false
            if (debug) {
              const txrelayed: any = ret.logs.find(e => e.event === 'TransactionRelayed')
              console.log('acceptanceBudget=', gas, 'ret=', txrej != null, 'innerGasUsed=', txrej?.args?.innerGasUsed?.toString(), decodeRevertReason(txrej?.args.reason), 'relayed:',
                txrelayed?.args?.status?.toString(), 'charge=', txrelayed?.args?.charge.toString())
            }
            return txrej != null
          } finally {
            await revert(snap.result)
          }
        }
        // now we move down acceptanceBudget, until relay will pay for it:
        const budget = await bsearch(1, 200000, checkAcceptanceBudget)

        console.log('calculated budget,', budget, ',msglen,', encoded.length / 2, ',estimForwarderCall,', estimForwarderCall, ',forwarderDataCost,', forwarderDataCost)
      }))
  })
})
