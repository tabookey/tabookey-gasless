import HttpWrapper from '@opengsn/common/dist/HttpWrapper'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'

const { expect, assert } = chai.use(chaiAsPromised)

describe('HttpWrapper', () => {
  it('connect to node, get version', async () => {
    const http = new HttpWrapper()
    // @ts-ignore
    const url = web3.currentProvider.host
    const res = await http.sendPromise(url, {
      jsonrpc: '2.0',
      method: 'net_version',
      id: 123
    })

    assert.equal(123, res.id, JSON.stringify(res)) // just verify its a valid response
  })

  it('should fail on connection refused', async () => {
    const http = new HttpWrapper()
    const res = http.sendPromise('http://localhost:44321', {
      jsonrpc: '2.0',
      method: 'net_version',
      id: 123
    })
    // @ts-ignore
    await expect(res).to.be.eventually.rejectedWith({ error: 'connect ECONNREFUSED 127.0.0.1:44321' })
  })

  it('should timeout after specified time', async () => {
    // this test abuses the fact that a local ganache is slow, and should take over 1ms to respond even if it's local
    const http = new HttpWrapper({ timeout: 1 })
    const res =
      // @ts-ignore
      http.sendPromise(web3.currentProvider.host, {
        jsonrpc: '2.0',
        method: 'net_version',
        id: 123
      })
    return await expect(res).to.be.eventually.rejectedWith('timeout of 1ms exceeded')
  })
})
