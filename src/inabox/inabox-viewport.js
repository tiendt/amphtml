/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {childElementByTag} from '../../src/dom.js';
import {iframeMessagingClientFor} from './inabox-iframe-messaging-client';
import {viewerForDoc} from '../services';
import {Viewport, ViewportBindingDef} from '../service/viewport-impl';
import {registerServiceBuilderForDoc} from '../service';
import {resourcesForDoc} from '../services';
import {
  nativeIntersectionObserverSupported,
} from '../../src/intersection-observer-polyfill';
import {DOMRectLtwh} from '../DOM-rect';
import {Observable} from '../observable';
import {MessageType} from '../../src/3p-frame-messaging';
import {dev} from '../log';
import {vsyncFor} from '../../src/services';
import {px, setStyles} from '../../src/style';


/** @const {string} */
const TAG = 'inabox-viewport';


/**
 * @param {!HTMLBodyElement} bodyElement
 * @return {!Element}
 * @visibleForTesting
 */
 // TODO(alanorozco):
//   Move this where it makes sense
export function getFixedContainer(bodyElement) {
  return dev().assertElement(childElementByTag(
      dev().assertElement(bodyElement), 'amp-ad-banner'));
}


/** @visibleForTesting */
export function prepareFixedContainer(win, fixedContainer) {
  return vsyncFor(win).runPromise({
    measure: state => {
      state.boundingRect = fixedContainer./*OK*/getBoundingClientRect();
    },
    mutate: state => {
      setStyles(dev().assertElement(win.document.body), {
        'background': 'transparent',
      });

      setStyles(fixedContainer, {
        'position': 'absolute',
        'left': '50%',
        'top': '50%',
        'right': 'auto',
        'bottom': 'auto',
        'width': px(state.boundingRect.width),
        'height': px(state.boundingRect.height),
        'margin-left': px(-(state.boundingRect.width / 2)),
        'margin-top': px(-(state.boundingRect.height / 2)),
      });
    },
  }, {});
}


/** @visibleForTesting */
export function resetFixedContainer(win, fixedContainer) {
  return vsyncFor(win).mutatePromise(() => {
    setStyles(dev().assertElement(win.document.body), {
      'background': 'transparent',
    });

    setStyles(fixedContainer, {
      'position': null,
      'left': null,
      'top': null,
      'right': null,
      'bottom': null,
      'width': null,
      'height': null,
      'margin-left': null,
      'margin-top': null,
    });
  });
}


/**
 * Implementation of ViewportBindingDef that works inside an non-scrollable
 * iframe box by listening to host doc for position and resize updates.
 *
 * @visibleForTesting
 * @implements {ViewportBindingDef}
 */
export class ViewportBindingInabox {

  /**
   * @param {!Window} win
   */
  constructor(win) {
    /** @const {!Window} */
    this.win = win;

    /** @private @const {!Observable} */
    this.scrollObservable_ = new Observable();

    /** @private @const {!Observable} */
    this.resizeObservable_ = new Observable();

    const boxWidth = win./*OK*/innerWidth;
    const boxHeight = win./*OK*/innerHeight;

    /**
     * The current viewport rect.
     * Before hearing from host doc, we're blind about the viewport position
     * and iframe position. 0 scroll is not a bad guess.
     * Meanwhile, use iframe box size as the viewport size gives a good
     * initial resource scheduling.
     * @private {!../DOM-rect.DOMRectDef}
     */
    this.viewportRect_ = DOMRectLtwh(0, 0, boxWidth, boxHeight);

    /**
     * The current DOM rect of the iframe box.
     * TODO(lannka, #7971): The best way to stop visibility from firing
     * is to move this functionality to the InOb polyfill.
     * ~To not trigger amp-analytics visibility immediately,
     * we start with an initial position right below the fold.~
     * @private {!../DOM-rect.DOMRectDef}
     */
    this.boxRect_ = DOMRectLtwh(0, boxHeight + 1, boxWidth, boxHeight);

    /** @private @const {!../../3p/iframe-messaging-client.IframeMessagingClient} */
    this.iframeClient_ = iframeMessagingClientFor(win);

    dev().fine(TAG, 'initialized inabox viewport');
  }

  /** @override */
  connect() {
    if (nativeIntersectionObserverSupported(this.win)) {
      // Using native IntersectionObserver, no position data needed
      // from host doc.
      return;
    }
    this.iframeClient_.makeRequest(
        MessageType.SEND_POSITIONS, MessageType.POSITION,
        data => {
          dev().fine(TAG, 'Position changed: ', data);
          const oldViewportRect = this.viewportRect_;
          const oldSelfRect = this.boxRect_;
          this.viewportRect_ = data.viewport;
          this.boxRect_ = data.target;
          if (isChanged(this.boxRect_, oldSelfRect)) {
            // Remeasure all AMP elements once iframe position is changed.
            // Because all layout boxes are calculated relatively to the
            // iframe position.
            this.remeasureAllElements_();
            // TODO: fire DOM mutation event once we handle them
          }
          if (isResized(this.viewportRect_, oldViewportRect)) {
            this.resizeObservable_.fire();
          }
          if (isMoved(this.viewportRect_, oldViewportRect)) {
            this.scrollObservable_.fire();
          }
        });
  }

  /** @override */
  getDOMRect(el) {
    const b = el./*OK*/getBoundingClientRect();
    return DOMRectLtwh(
        Math.round(b.left + this.boxRect_.left),
        Math.round(b.top + this.boxRect_.top),
        Math.round(b.width),
        Math.round(b.height));
  }

  /** @override */
  onScroll(callback) {
    this.scrollObservable_.add(callback);
  }

  /** @override */
  onResize(callback) {
    this.resizeObservable_.add(callback);
  }

  /** @override */
  getSize() {
    return {
      width: this.viewportRect_.width,
      height: this.viewportRect_.height,
    };
  }

  /** @override */
  getScrollTop() {
    return this.viewportRect_.top;
  }

  /** @override */
  getScrollLeft() {
    return this.viewportRect_.left;
  }

  remeasureAllElements_() {
    const resources = resourcesForDoc(this.win.document).get();
    for (let i = 0; i < resources.length; i++) {
      resources[i].measure();
    }
  }

  /** @override */
  updateLightboxMode(lightboxMode) {
    if (lightboxMode) {
      return this.tryToEnterOverlayMode_();
    }
    return this.leaveOverlayMode_();
  }

  /**
   * @return {!Promise}
   * @private
   */
  tryToEnterOverlayMode_() {
    // TODO(alanorozco): Update viewport measurement from host message.
    return this.prepareFixedContainer_()
        .then(() => this.requestFullOverlayFrame_());
  }

  /**
   * @return {!Promise}
   * @private
   */
  leaveOverlayMode_() {
    return this.requestCancelFullOverlayFrame_()
        .then(() => this.resetFixedContainer_());
  }

  /**
   * Prepares the "fixed" container before expanding frame.
   * @return {!Promise}
   * @private
   */
  prepareFixedContainer_() {
    const fixedContainer = this.getFixedContainer_();

    if (!fixedContainer) {
      dev().warn(TAG, 'No fixed container inside frame, content will shift.');
      return Promise.resolve();
    }

    return prepareFixedContainer(this.win, dev().assertElement(fixedContainer));
  }

  /**
   * Resets the "fixed" container to its original position after collapse.
   * @return {!Promise}
   * @private
   */
  resetFixedContainer_() {
    const fixedContainer = this.getFixedContainer_();

    if (!fixedContainer) {
      dev().warn(TAG, 'No fixed container inside frame, content will shift.');
      return Promise.resolve();
    }

    return resetFixedContainer(this.win, dev().assertElement(fixedContainer));
  }

  /**
   * @return {!Promise}
   * @private
   */
  requestFullOverlayFrame_() {
    return new Promise((resolve, reject) => {
      this.iframeClient_.makeRequest(
          MessageType.FULL_OVERLAY_FRAME,
          MessageType.FULL_OVERLAY_FRAME_RESPONSE,
          response => {
            if (response.success) {
              resolve();
            } else {
              reject('Request to open lightbox rejected by host document');
            }
          });
    });
  }

  /**
   * @return {!Promise}
   * @private
   */
  requestCancelFullOverlayFrame_() {
    return new Promise(resolve => {
      this.iframeClient_.makeRequest(
          MessageType.CANCEL_FULL_OVERLAY_FRAME,
          MessageType.CANCEL_FULL_OVERLAY_FRAME_RESPONSE,
          resolve);
    });
  }

  getFixedContainer_() {
    return getFixedContainer(
        /** @type {!HTMLBodyElement} */ (dev().assert(this.win.document.body)));
  }

  /** @override */ disconnect() {/* no-op */}
  /** @override */ updatePaddingTop() {/* no-op */}
  /** @override */ hideViewerHeader() {/* no-op */}
  /** @override */ showViewerHeader() {/* no-op */}
  /** @override */ disableScroll() {/* no-op */}
  /** @override */ resetScroll() {/* no-op */}
  /** @override */ ensureReadyForElements() {/* no-op */}
  /** @override */ setScrollTop() {/* no-op */}
  /** @override */ getScrollWidth() {return 0;}
  /** @override */ getScrollHeight() {return 0;}
  /** @override */ getBorderTop() {return 0;}
  /** @override */ requiresFixedLayerTransfer() {return false;}
}

/**
 * @param {!../service/ampdoc-impl.AmpDoc} ampdoc
 */
export function installInaboxViewportService(ampdoc) {
  const binding = new ViewportBindingInabox(ampdoc.win);
  const viewer = viewerForDoc(ampdoc);
  registerServiceBuilderForDoc(ampdoc,
      'viewport',
      function() {
        return new Viewport(ampdoc, binding, viewer);
      },
      /* opt_instantiate */ true);
}

/**
 * @param {!../DOM-rect.DOMRectDef} newRect
 * @param {!../DOM-rect.DOMRectDef} oldRect
 * @returns {boolean}
 */
function isChanged(newRect, oldRect) {
  return isMoved(newRect, oldRect) || isResized(newRect, oldRect);
}

/**
 * @param {!../DOM-rect.DOMRectDef} newRect
 * @param {!../DOM-rect.DOMRectDef} oldRect
 * @returns {boolean}
 */
function isMoved(newRect, oldRect) {
  return newRect.left != oldRect.left || newRect.top != oldRect.top;
}

/**
 * @param {!../DOM-rect.DOMRectDef} newRect
 * @param {!../DOM-rect.DOMRectDef} oldRect
 * @returns {boolean}
 */
function isResized(newRect, oldRect) {
  return newRect.width != oldRect.width || newRect.height != oldRect.height;
}
