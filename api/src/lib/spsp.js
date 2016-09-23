"use strict"

const co = require('co')
const uuid = require ('uuid4')
const superagent = require('superagent-promise')(require('superagent'), Promise)

const ILP = require('ilp')
const FiveBellsLedgerAdminPlugin = require('ilp-plugin-bells-admin')

const PaymentFactory = require('../models/payment')
const Config = require('./config')
const Socket = require('./socket')

// TODO exception handling
module.exports = class SPSP {
  static constitute() { return [Config, PaymentFactory, Socket] }
  constructor(config, Payment, socket) {
    this.Payment = Payment
    this.socket = socket
    this.config = config

    this.ledgerPrefix = this.config.data.getIn(['ledger', 'prefix'])
    this.ledgerPublicUri = this.config.data.getIn(['ledger', 'public_uri'])

    this.adminName = this.config.data.getIn(['ledger', 'admin', 'name'])
    this.adminPass = this.config.data.getIn(['ledger', 'admin', 'pass'])

    this.senderPluginInstance = {ws: null}
    this.receiverPluginInstance = {ws: null}
    this.senders = {}
    this.receivers = {}
  }

  /**
   * Sender
   */

  // Get or create a sender instance
  allocateSender(username) {
    // TODO expire senders
    if (!this.senders[username]) {
      const sourceAccount = this.ledgerPublicUri + '/accounts/' + username

      this.senders[username] = {
        instance: ILP.createSender({
          _plugin: FiveBellsLedgerAdminPlugin,
          prefix: this.ledgerPrefix,
          account: sourceAccount,
          username: this.adminName,
          password: this.adminPass,
          instance: this.senderPluginInstance
        }),
        allocations: 0
      }
    }

    this.senders[username].allocations += 1

    return this.senders[username].instance
  }

  // Deallocate a single sender (destroys the object if there are no more allocations)
  * deallocateSender(username) {
    const sender = this.senders[username]

    if (!sender) return

    sender.allocations -= 1

    if (sender.allocations < 1) {
      try {
        yield sender.instance.stopListening()
      } catch (e) {}

      delete this.senders[username]
    }
  }

  * quote(params) {
    const username = params.source.username
    const sender = this.allocateSender(username)

    // One of the amounts should be supplied to get a quote for the other one
    let sourceAmount, destinationAmount

    try {
      sourceAmount = params.sourceAmount || (
        yield sender.quoteDestinationAmount(
          params.destination.ilpAddress,
          params.destinationAmount))
      destinationAmount = params.destinationAmount || (
        yield sender.quoteSourceAmount(
          params.destination.ilpAddress,
          params.sourceAmount))

      yield this.deallocateSender(username)

      return {
        sourceAmount,
        destinationAmount
      }
    } catch (e) {
      // Make sure to deallocate even if the quoting failed
      yield this.deallocateSender(username)

      throw e
    }
  }

  * setup(options) {
    return (yield superagent.post(options.paymentUri, {
      amount: options.amount,
      sender_identifier: options.sender_identifier,
      memo: options.memo
    })).body
  }

  * pay(params) {
    const sender = this.allocateSender(params.source.username)

    try {
      const quote = yield this.setup({
        paymentUri: params.destination.paymentUri,
        amount: params.destinationAmount,
        sender_identifier: params.source.username,
        memo: params.memo
      })

      const paymentParams = yield sender.quoteRequest(quote)

      // Sometimes 'paymentParams' comes with a (slightly) different sourceAmount
      paymentParams.sourceAmount = params.sourceAmount
      paymentParams.uuid = uuid()

      // TODO any rounding stuff here?
      // Make sure the deliverable amount is what the user agreed with
      if (parseFloat(paymentParams.destinationAmount) !== parseFloat(params.destinationAmount)) {
        // TODO handle
        return
      }

      yield sender.payRequest(paymentParams)

      // Deallocate the sender
      yield this.deallocateSender(params.source.username)

      return paymentParams
    } catch (e) {
      // Make sure to deallocate even if the payment failed
      yield this.deallocateSender(params.source.username)

      throw e
    }
  }

  /**
   * Receiver
   */
  // Get or create a receiver instance
  * allocateReceiver(username) {
    // TODO expire receivers
    if (!this.receivers[username]) {
      const destinationAccount = this.ledgerPublicUri + '/accounts/' + username
      const instance = ILP.createReceiver({
        _plugin: FiveBellsLedgerAdminPlugin,
        prefix: this.ledgerPrefix,
        account: destinationAccount,
        username: this.adminName,
        password: this.adminPass,
        instance: this.receiverPluginInstance
      })

      this.receivers[username] = {
        instance,
        allocations: 0
      }

      try {
        yield instance.listen()
      } catch (e) {
        instance.stopListening()

        throw e
      }
    }

    this.receivers[username].allocations += 1

    return this.receivers[username].instance
  }

  // Deallocate a single receiver (destroys the object if there are no more allocations)
  * deallocateReceiver(username) {
    const receiver = this.receivers[username]

    if (!receiver) return

    receiver.allocations -= 1

    if (receiver.allocations < 1) {
      try {
        yield receiver.instance.stopListening()
      } catch (e) {}

      delete this.receivers[username]
    }
  }

  * createRequest(destinationUser, destinationAmount) {
    const self = this
    const username = destinationUser.username

    const receiver = yield self.allocateReceiver(username)

    // Deallocate the receiver in case if we don't hear from the receiver anymore
    const receiverTimeout = setTimeout(co.wrap(function *() { 
      yield self.deallocateReceiver(username)
    }), 10000) // TODO don't hardcode

    const request = receiver.createRequest({
      amount: destinationAmount
    })

    const requestId = request.address.replace(self.ledgerPrefix + username + '.', '')

    // Remove this listener on finish
    receiver.on('incoming:' + requestId, co.wrap(function *(transfer) {
      // Get the db payment
      const dbPayment = yield self.Payment.findOne({
        where: {
          // TODO should it really be referenced by a condition?
          execution_condition: transfer.executionCondition
        }
      })

      // Update the db payment
      dbPayment.state = 'success'
      yield dbPayment.save()

      // Notify the clients
      // TODO should probably have the same format as the payment in history
      self.socket.payment(username, dbPayment)

      // Deallocate the receiver
      clearTimeout(receiverTimeout)
      yield self.deallocateReceiver(username)
    }))

    return request
  }
}
