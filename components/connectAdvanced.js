import hoistStatics from 'hoist-non-react-statics'
import React, { useContext, useMemo, useRef, useReducer } from 'react'
import { isValidElementType, isContextConsumer } from 'react-is'
import { createSubscription } from '../utils/Subscription'
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect'

import { ReactReduxContext } from './Context'

// Define some constant arrays just to avoid re-creating these
const EMPTY_ARRAY = []
const NO_SUBSCRIPTION_ARRAY = [null, null]

const stringifyComponent = (Comp) => {
  try {
    return JSON.stringify(Comp)
  } catch (err) {
    return String(Comp)
  }
}

function storeStateUpdatesReducer(state, action) {
  const [, updateCount] = state
  return [action.payload, updateCount + 1]
}

function useIsomorphicLayoutEffectWithArgs(
  effectFunc,
  effectArgs,
  dependencies
) {
  // 等同于useEffect, 根据客户端，服务端渲染使用useLayoutEffect以及useEffect
  useIsomorphicLayoutEffect(() => effectFunc(...effectArgs), dependencies)
}

function captureWrapperProps(
  lastWrapperProps,
  lastChildProps,
  renderIsScheduled,
  wrapperProps,
  actualChildProps,
  childPropsFromStoreUpdate,
  notifyNestedSubs
) {
  // We want to capture the wrapper props and child props we used for later comparisons
  lastWrapperProps.current = wrapperProps
  lastChildProps.current = actualChildProps
  renderIsScheduled.current = false

  // 假如是store的更新导致的渲染，清除掉标识位，通知订阅者更新
  if (childPropsFromStoreUpdate.current) {
    childPropsFromStoreUpdate.current = null
    notifyNestedSubs()
  }
}

function subscribeUpdates(
  shouldHandleStateChanges,
  store,
  subscription,
  childPropsSelector,
  lastWrapperProps,
  lastChildProps,
  renderIsScheduled,
  childPropsFromStoreUpdate,
  notifyNestedSubs,
  forceComponentUpdateDispatch
) {
  // If we're not subscribed to the store, nothing to do here
  if (!shouldHandleStateChanges) return

  // Capture values for checking if and when this component unmounts
  let didUnsubscribe = false
  let lastThrownError = null

  // We'll run this callback every time a store subscription update propagates to this component
  const checkForUpdates = () => {
    if (didUnsubscribe) {
      // Don't run stale listeners.
      // Redux doesn't guarantee unsubscriptions happen until next dispatch.
      return
    }

    const latestStoreState = store.getState()

    let newChildProps, error
    try {
      // 获取当前子组件的props
      newChildProps = childPropsSelector(
        latestStoreState,
        lastWrapperProps.current
      )
    } catch (e) {
      error = e
      lastThrownError = e
    }

    if (!error) {
      lastThrownError = null
    }

    // 假如子组件的props没有发生变化，并且不属于更新周期内，只通知子订阅者更新
    if (newChildProps === lastChildProps.current) {
      if (!renderIsScheduled.current) {
        notifyNestedSubs()
      }
    } else {
      // Save references to the new child props.  Note that we track the "child props from store update"
      // as a ref instead of a useState/useReducer because we need a way to determine if that value has
      // been processed.  If this went into useState/useReducer, we couldn't clear out the value without
      // forcing another re-render, which we don't want.
      lastChildProps.current = newChildProps
      childPropsFromStoreUpdate.current = newChildProps
      renderIsScheduled.current = true

      // 假如子组件的props变化了，父组件需要重新更新
      forceComponentUpdateDispatch({
        type: 'STORE_UPDATED',
        payload: {
          error,
        },
      })
    }
  }

  // Actually subscribe to the nearest connected ancestor (or store)
  // 将更新函数绑定在最近的父级订阅者上
  subscription.onStateChange = checkForUpdates
  subscription.trySubscribe()

  // Pull data from the store after first render in case the store has
  // changed since we began.
  // 从store首次渲染后就获取数据缓存，以防store数据变化
  checkForUpdates()

  const unsubscribeWrapper = () => {
    didUnsubscribe = true
    subscription.tryUnsubscribe()
    subscription.onStateChange = null

    if (lastThrownError) {
      // It's possible that we caught an error due to a bad mapState function, but the
      // parent re-rendered without this component and we're about to unmount.
      // This shouldn't happen as long as we do top-down subscriptions correctly, but
      // if we ever do those wrong, this throw will surface the error in our tests.
      // In that case, throw the error from here so it doesn't get lost.
      throw lastThrownError
    }
  }

  return unsubscribeWrapper
}

const initStateUpdates = () => [null, 0]

export default function connectAdvanced(
  /*
    selectorFactory is a func that is responsible for returning the selector function used to
    compute new props from state, props, and dispatch. For example:

      export default connectAdvanced((dispatch, options) => (state, props) => ({
        thing: state.things[props.thingId],
        saveThing: fields => dispatch(actionCreators.saveThing(props.thingId, fields)),
      }))(YourComponent)

    Access to dispatch is provided to the factory so selectorFactories can bind actionCreators
    outside of their selector as an optimization. Options passed to connectAdvanced are passed to
    the selectorFactory, along with displayName and WrappedComponent, as the second argument.

    Note that selectorFactory is responsible for all caching/memoization of inbound and outbound
    props. Do not use connectAdvanced directly without memoizing results between calls to your
    selector, otherwise the Connect component will re-render on every state or props change.
  */
  selectorFactory,
  // options object:
  {
    // the func used to compute this HOC's displayName from the wrapped component's displayName.
    // probably overridden by wrapper functions such as connect()
    getDisplayName = (name) => `ConnectAdvanced(${name})`,

    // 错误信息展示时
    methodName = 'connectAdvanced', 

    // 用于开发者工具调试是否有不必要的重复渲染
    renderCountProp = undefined,

    // 定义是否有订阅store的变化
    shouldHandleStateChanges = true,

    // 从store获取 props/context 的key
    storeKey = 'store',

    // REMOVED: expose the wrapped component via refs
    withRef = false,

    // use React's forwardRef to expose a ref of the wrapped component
    forwardRef = false,

    // context consumer  Provider 保存的上下文
    context = ReactReduxContext,

    // additional options are passed through to the selectorFactory
    ...connectOptions
  } = {}
) {
  if (process.env.NODE_ENV !== 'production') {
    if (renderCountProp !== undefined) {
      throw new Error(
        `renderCountProp is removed. render counting is built into the latest React Dev Tools profiling extension`
      )
    }
    if (withRef) {
      throw new Error(
        'withRef is removed. To access the wrapped instance, use a ref on the connected component'
      )
    }

    const customStoreWarningMessage =
      'To use a custom Redux store for specific components, create a custom React context with ' +
      "React.createContext(), and pass the context object to React Redux's Provider and specific components" +
      ' like: <Provider context={MyContext}><ConnectedComponent context={MyContext} /></Provider>. ' +
      'You may also pass a {context : MyContext} option to connect'

    if (storeKey !== 'store') {
      throw new Error(
        'storeKey has been removed and does not do anything. ' +
          customStoreWarningMessage
      )
    }
  }

  const Context = context

  return function wrapWithConnect(WrappedComponent) {
    if (
      process.env.NODE_ENV !== 'production' &&
      !isValidElementType(WrappedComponent)
    ) {
      throw new Error(
        `You must pass a component to the function returned by ` +
          `${methodName}. Instead received ${stringifyComponent(
            WrappedComponent
          )}`
      )
    }

    const wrappedComponentName =
      WrappedComponent.displayName || WrappedComponent.name || 'Component'

    const displayName = getDisplayName(wrappedComponentName)

    const selectorFactoryOptions = {
      ...connectOptions,
      getDisplayName,
      methodName,
      renderCountProp,
      shouldHandleStateChanges,
      storeKey,
      displayName,
      wrappedComponentName,
      WrappedComponent,
    }

    const { pure } = connectOptions

    function createChildSelector(store) {
      return selectorFactory(store.dispatch, selectorFactoryOptions)
    }

    //判断是否是pure纯组件模式 如果是 将用 useMemo 提升性能
    const usePureOnlyMemo = pure ? useMemo : (callback) => callback()

    // useMemo提升性能
    function ConnectFunction(props) {
      const [propsContext, reactReduxForwardedRef, wrapperProps] =
        useMemo(() => {
          // Distinguish between actual "data" props that were passed to the wrapper component,
          // and values needed to control behavior (forwarded refs, alternate context instances).
          // To maintain the wrapperProps object reference, memoize this destructuring.
          const { reactReduxForwardedRef, ...wrapperProps } = props
          return [props.context, reactReduxForwardedRef, wrapperProps]
        }, [props])

      // 判断是使用自定的context还是 ReactReduxContext， 同时将其缓存
      const ContextToUse = useMemo(() => {
        return propsContext &&
          propsContext.Consumer &&
          isContextConsumer(<propsContext.Consumer />)
          ? propsContext
          : Context
      }, [propsContext, Context])

      // 获取store或者父级传入的context
      const contextValue = useContext(ContextToUse)

      // 判断store是来自于props还是context, 正常情况下，store是不会来源于props
      const didStoreComeFromProps =
        Boolean(props.store) &&
        Boolean(props.store.getState) &&
        Boolean(props.store.dispatch)
      const didStoreComeFromContext =
        Boolean(contextValue) && Boolean(contextValue.store)

      if (
        process.env.NODE_ENV !== 'production' &&
        !didStoreComeFromProps &&
        !didStoreComeFromContext
      ) {
        throw new Error(
          `Could not find "store" in the context of ` +
            `"${displayName}". Either wrap the root component in a <Provider>, ` +
            `or pass a custom React context provider to <Provider> and the corresponding ` +
            `React context consumer to ${displayName} in connect options.`
        )
      }

      // 根据判断，获取最终的store
      const store = didStoreComeFromProps ? props.store : contextValue.store

      const childPropsSelector = useMemo(() => {
        // 返回merge函数 用于生成真正传给子组件 props
        return createChildSelector(store)
      }, [store])

      const [subscription, notifyNestedSubs] = useMemo(() => {
        if (!shouldHandleStateChanges) return NO_SUBSCRIPTION_ARRAY

        const subscription = createSubscription(
          store,
          // 和 上级 `subscription` 建立起关系。 this.parentSub = contextValue.subscription
          didStoreComeFromProps ? null : contextValue.subscription
        )

        // notifyNestedSubs 触发 noticy 所有子代 listener 监听者 -> 触发batch方法,触发 batchupdate方法 ,批量更新
        const notifyNestedSubs =
          subscription.notifyNestedSubs.bind(subscription)

        return [subscription, notifyNestedSubs]
      }, [store, didStoreComeFromProps, contextValue])

      //  创建出一个新的contextValue ,把父级的 subscription 换成自己的 subscription
      const overriddenContextValue = useMemo(() => {
        if (didStoreComeFromProps) {
          return contextValue
        }
        return {
          ...contextValue,
          subscription,
        }
      }, [didStoreComeFromProps, contextValue, subscription])

      // 需要让被包裹组件更新，当store更新时
      const [[previousStateUpdateResult], forceComponentUpdateDispatch] =
        useReducer(storeStateUpdatesReducer, EMPTY_ARRAY, initStateUpdates)

      // 抛出state更新时的错误
      if (previousStateUpdateResult && previousStateUpdateResult.error) {
        throw previousStateUpdateResult.error
      }

      const lastChildProps = useRef() //保存上一次 合并过的 props信息（经过 ownprops ,stateProps , dispatchProps 合并过的 ）
      const lastWrapperProps = useRef(wrapperProps) // 保存组件传入的props
      const childPropsFromStoreUpdate = useRef()
      const renderIsScheduled = useRef(false) // 当前组件是否处于渲染阶段

      const actualChildProps = usePureOnlyMemo(() => {
        // 当前一次的wrapperProps和当前的一致时， 直接使用childPropsFromStoreUpdate保存的数据
        if (
          childPropsFromStoreUpdate.current &&
          wrapperProps === lastWrapperProps.current
        ) {
          return childPropsFromStoreUpdate.current
        }

      // 调用 childPropsSelector获取最终的child的props
        return childPropsSelector(store.getState(), wrapperProps)
      }, [store, previousStateUpdateResult, wrapperProps])

      // 负责更新缓存变量，方便下一次更新的时候比较
      // captureWrapperProps 的作用很简单，在一次组件渲染更新后，将上一次 合并前 和 合并后 的props,保存起来。
      // 这么做目的是，能过在两次hoc执行渲染中，对比props stateProps是否发生变化。从而确定是否更新 hoc，进一步更新组件
      useIsomorphicLayoutEffectWithArgs(captureWrapperProps, [
        lastWrapperProps,
        lastChildProps,
        renderIsScheduled,
        wrapperProps,
        actualChildProps,
        childPropsFromStoreUpdate,
        notifyNestedSubs,
      ])

      // Our re-subscribe logic only runs when the store/subscription setup changes
      // 订阅更新的逻辑
      useIsomorphicLayoutEffectWithArgs(
        subscribeUpdates,
        [
          shouldHandleStateChanges,
          store,
          subscription,
          childPropsSelector,
          lastWrapperProps,
          lastChildProps,
          renderIsScheduled,
          childPropsFromStoreUpdate,
          notifyNestedSubs,
          forceComponentUpdateDispatch,
        ],
        [store, subscription, childPropsSelector]
      )

      // 将最终的props注入被包裹组件，同时使用memo优化
      const renderedWrappedComponent = useMemo(
        () => (
          <WrappedComponent
            {...actualChildProps}
            ref={reactReduxForwardedRef}
          />
        ),
        [reactReduxForwardedRef, WrappedComponent, actualChildProps]
      )

      const renderedChild = useMemo(() => {
        //shouldHandleStateChanges 来源 connect是否有第一个参数

        //overriddenContextValue 为重新组合的 context & subscription
        if (shouldHandleStateChanges) {
          return (
            <ContextToUse.Provider value={overriddenContextValue}>
              {renderedWrappedComponent}
            </ContextToUse.Provider>
          )
        }

        return renderedWrappedComponent
      }, [ContextToUse, renderedWrappedComponent, overriddenContextValue])

      return renderedChild
    }

    const Connect = pure ? React.memo(ConnectFunction) : ConnectFunction

    Connect.WrappedComponent = WrappedComponent
    Connect.displayName = ConnectFunction.displayName = displayName

    if (forwardRef) {
      const forwarded = React.forwardRef(function forwardConnectRef(
        props,
        ref
      ) {
        return <Connect {...props} reactReduxForwardedRef={ref} />
      })

      forwarded.displayName = displayName
      forwarded.WrappedComponent = WrappedComponent
      return hoistStatics(forwarded, WrappedComponent)
    }

    return hoistStatics(Connect, WrappedComponent)
  }
}
