import { getBatch } from './batch'

// encapsulates the subscription logic for connecting a component to the redux store, as
// well as nesting subscriptions of descendant components, so that we can ensure the
// ancestor components re-render before descendants

function createListenerCollection() {
  const batch = getBatch()
  let first = null
  let last = null

  return {
    // 清除当前
    clear() {
      first = null
      last = null
    },

    // 执行
    notify() {
      batch(() => {
        let listener = first
        while (listener) {
          listener.callback()
          listener = listener.next
        }
      })
    },

    get() {
      let listeners = []
      let listener = first
      while (listener) {
        listeners.push(listener)
        listener = listener.next
      }
      return listeners
    },

    // 订阅listen，即onStateChange/handleChangeWrapper函数，存到当前的链表中
    subscribe(callback) {
      let isSubscribed = true

      let listener = (last = {
        callback,
        next: null,
        prev: last,
      })

      if (listener.prev) {
        listener.prev.next = listener
      } else {
        first = listener
      }

      return function unsubscribe() {
        if (!isSubscribed || first === null) return
        isSubscribed = false

        if (listener.next) {
          listener.next.prev = listener.prev
        } else {
          last = listener.prev
        }
        if (listener.prev) {
          listener.prev.next = listener.next
        } else {
          first = listener.next
        }
      }
    },
  }
}

const nullListeners = {
  notify() {},
  get: () => [],
}

export function createSubscription(store, parentSub) {
  let unsubscribe
  let listeners = nullListeners

  function addNestedSub(listener) {
    // 检测是否有订阅，假如没有则根据是否存在父级订阅者，将更新函数放入 listeners.subscribe 中
    trySubscribe()
    return listeners.subscribe(listener)
  }

  // 向listeners发布通知
  function notifyNestedSubs() {
    listeners.notify()
  }

  // 对于 provide onStateChange 就是 notifyNestedSubs 方法，对于 connect 包裹接受更新的组件 ，onStateChange 就是 负责更新组件的函数
  function handleChangeWrapper() {
    if (subscription.onStateChange) {
      subscription.onStateChange()
    }
  }

  // 判断是否订阅
  function isSubscribed() {
    return Boolean(unsubscribe)
  }

  function trySubscribe() {
    // 开启订阅模式 首先判断当前订阅器有没有父级订阅器，如果有父级订阅器(就是父级Subscription)，把自己的handleChangeWrapper放入到监听者链表中
    if (!unsubscribe) {
      unsubscribe = parentSub
        ? parentSub.addNestedSub(handleChangeWrapper)
        // provider的Subscription是不存在parentSub，所以此时trySubscribe 就会调用 store.subscribe
        : store.subscribe(handleChangeWrapper)

      listeners = createListenerCollection()
    }
  }

  // 取消订阅
  function tryUnsubscribe() {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = undefined
      listeners.clear()
      listeners = nullListeners
    }
  }

  const subscription = {
    addNestedSub,
    notifyNestedSubs,
    handleChangeWrapper,
    isSubscribed,
    trySubscribe,
    tryUnsubscribe,
    getListeners: () => listeners,
  }

  return subscription
}

/**
    Subscription 的作用,首先通过 trySubscribe 发起订阅模式，如果存在这父级订阅者，就把自己更新函数handleChangeWrapper，传递给父
  级订阅者，然后父级由 addNestedSub 方法将此时的回调函数（更新函数）添加到当前的 listeners 中 。如果没有父级元素(Provider的情况)，
  则将此回调函数放在store.subscribe中，handleChangeWrapper 函数中onStateChange，就是 Provider 中 Subscription 的 notifyNestedSubs
  方法，而 notifyNestedSubs 方法会通知listens 的 notify 方法来触发更新。这里透漏一下，子代Subscription会把更新自身handleChangeWrapper传递
  给parentSub，来统一通知connect组件更新
*/

/**
    state更改 -> store.subscribe -> 触发 provider 的 Subscription 的 handleChangeWrapper 也就是  notifyNestedSubs -> 通知 listeners.notify()
  -> 通知每个被connect 容器组件的更新 -> callback 执行 -> 触发子组件Subscription 的 handleChangeWrapper ->触发子onstatechange
*/