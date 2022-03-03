import React, { useMemo } from 'react'
import PropTypes from 'prop-types'
import { ReactReduxContext } from './Context'
import { createSubscription } from '../utils/Subscription'
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect'

function Provider({ store, context, children }) {
  const contextValue = useMemo(() => {
    // 创建一个 subscription 实例
    const subscription = createSubscription(store)
    /* subscription 的 notifyNestedSubs 方法 ，赋值给 onStateChange方法 */
    subscription.onStateChange = subscription.notifyNestedSubs
    return {
      store,
      subscription,
    }
  }, [store])

  // 获取，存储渲染前的state，用于后续的比对
  const previousState = useMemo(() => store.getState(), [store])

  // 等同于useEffect（重写的用于客户端与服务端使用）
  useIsomorphicLayoutEffect(() => {
    const { subscription } = contextValue
    // 触发 trySubscribe 方法执行，创建listens
    subscription.trySubscribe()

    // 比对当前的state与之前暂存的state（渲染前）的state，判断是否触发 notifyNestedSubs 方法
    if (previousState !== store.getState()) {
      subscription.notifyNestedSubs()
    }
    return () => {
      // 取消订阅
      subscription.tryUnsubscribe()
      subscription.onStateChange = null
    }
  }, [contextValue, previousState])

  const Context = context || ReactReduxContext // 优先使用传入的context，否则使用redux的公共context

  return <Context.Provider value={contextValue}>{children}</Context.Provider>
}

if (process.env.NODE_ENV !== 'production') {
  Provider.propTypes = {
    store: PropTypes.shape({
      subscribe: PropTypes.func.isRequired,
      dispatch: PropTypes.func.isRequired,
      getState: PropTypes.func.isRequired,
    }),
    context: PropTypes.object,
    children: PropTypes.any,
  }
}

// 总结
/*
  1 首先创建一个 contextValue ，里面包含一个创建出来的父级 Subscription (我们姑且先称之为根级订阅器)和redux提供的store。
  2 通过react上下文context把 contextValue 传递给子孙组件。
*/

export default Provider
