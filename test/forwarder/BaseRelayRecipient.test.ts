import {
  ForwarderInstance,
  TestForwarderTargetInstance
} from '../../types/truffle-contracts'
import { toHex } from 'web3-utils'

require('source-map-support').install({ errorFormatterForce: true })

const TestForwarderTarget = artifacts.require('TestForwarderTarget')

const Forwarder = artifacts.require('Forwarder')

contract('BaseRelayRecipient', ([from, sender]) => {
  let recipient: TestForwarderTargetInstance
  let fwd: ForwarderInstance
  before(async () => {
    fwd = await Forwarder.new()
    recipient = await TestForwarderTarget.new(fwd.address)
  })

  it('#_msgSender', async function () {
    async function callMsgSender (from: string, appended = ''): Promise<any> {
      const encoded = recipient.contract.methods.publicMsgSender().encodeABI() as string
      const ret = await web3.eth.call({ from, to: recipient.address, data: encoded + appended.replace(/^0x/, '') }) as string
      return web3.eth.abi.decodeParameter('address', ret)
    }

    assert.equal(await callMsgSender(from), from, 'should leave from address as-is if not from trusted forwarder')
    assert.equal(await callMsgSender(fwd.address), fwd.address, 'should leave from address as-is if not enough appended data')
    assert.equal(await callMsgSender(fwd.address, '12345678'), fwd.address, 'should leave from address as-is if not enough appended data')

    const sender = '0x'.padEnd(42, '12')
    assert.equal(await callMsgSender(fwd.address, sender), sender,
      'should extract from address if called through trusted forwarder')
  })

  it('#_msgData', async function () {
    const encoded = recipient.contract.methods.publicMsgData().encodeABI() as string

    async function callMsgData (from: string, appended = ''): Promise<any> {
      const ret = await web3.eth.call({
        from,
        to: recipient.address,
        data: encoded + appended.replace(/^0x/, '')
      }) as string
      return web3.eth.abi.decodeParameter('bytes', ret)
    }

    const extra = toHex('some extra data to add, which is longer than 20 bytes').slice(2)
    assert.equal(await callMsgData(from), encoded, 'should leave msg.data as-is if not from trusted forwarder')
    assert.equal(await callMsgData(from, extra), encoded + extra, 'should leave msg.data as-is if not from trusted forwarder')

    assert.equal(await callMsgData(fwd.address), encoded, 'should leave msg.data as-is if not enough appended data')

    const sender = '0x'.padEnd(42, '12')
    assert.equal(await callMsgData(fwd.address, extra + sender.slice(2)), encoded + extra,
      'should extract msg.data if called through trusted forwarder')
  })

  it('should extract msgSender and msgData in transaction', async () => {
    // trust "from" as forwarder (using real forwarder requires signing
    const recipient = await TestForwarderTarget.new(from)
    const encoded = recipient.contract.methods.emitMessage('hello').encodeABI() as string
    const encodedWithSender = encoded + sender.slice(2)
    await web3.eth.sendTransaction({ from, to: recipient.address, data: encodedWithSender })
    const events = await recipient.contract.getPastEvents(null, { fromBlock: 1 })
    const params = events[0].returnValues
    assert.equal(params.realSender, sender)
    assert.equal(params.msgSender, from)
    assert.equal(params.realMsgData, encoded)
  })
})
