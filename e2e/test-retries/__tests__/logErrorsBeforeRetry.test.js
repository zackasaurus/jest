/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

jest.retryTimes(1);
jest.setLogTestErrorsBeforeRetry(true);
it('retryTimes set', () => {
  expect(true).toBeFalsy();
});
