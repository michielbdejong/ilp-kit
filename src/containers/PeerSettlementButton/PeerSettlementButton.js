import React, { Component, PropTypes } from 'react'
import { connect } from 'react-redux'
import { DropdownButton, MenuItem } from 'react-bootstrap'
import { LinkContainer } from 'react-router-bootstrap'

import { getSettlementMethods } from 'redux/actions/peer'

import classNames from 'classnames/bind'
import styles from './PeerSettlementButton.scss'
const cx = classNames.bind(styles)

@connect(state => ({}), { getSettlementMethods })
export default class Peers extends Component {
  static propTypes = {
    peer: PropTypes.object.isRequired,
    getSettlementMethods: PropTypes.func.isRequired
  }

  state = {}

  handleToggle = (isOpen) => {
    if (!isOpen) return

    this.props.getSettlementMethods(this.props.peer.id)
      .then(methods => {
        this.setState({
          ...this.state,
          methods
        })
      })
  }

  renderMethod = method => {
    return (
      <MenuItem href={method.uri} key={method.name}>
        <img src={method.logo} className={cx('logo')} />
        {method.name}
      </MenuItem>
    )
  }

  render() {
    const { methods } = this.state

    return (
      <DropdownButton bsStyle="info" title="Settle" onToggle={this.handleToggle} id="settlement">
        {!methods && <MenuItem>Loading...</MenuItem>}
        {methods && methods.length === 0 && <MenuItem>No Settlement Options available</MenuItem>}
        {methods && methods.map(this.renderMethod)}
      </DropdownButton>
    )
  }
}
