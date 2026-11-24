import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getNextRovingTabIndex,
  resolveLeftRailWidthClass,
  shouldCollapseLeftRailByDefault,
  shouldShowStudioWorkbenchChrome,
} from './layoutUtils.ts';

test('shouldCollapseLeftRailByDefault collapses below 1280px and stays expanded on 1440px+', () => {
  assert.equal(shouldCollapseLeftRailByDefault(1024), true);
  assert.equal(shouldCollapseLeftRailByDefault(1279), true);
  assert.equal(shouldCollapseLeftRailByDefault(1280), false);
  assert.equal(shouldCollapseLeftRailByDefault(1440), false);
  assert.equal(shouldCollapseLeftRailByDefault(0), false);
});

test('shouldShowStudioWorkbenchChrome hides studio transport/stepper on dedicated Lab views', () => {
  assert.equal(shouldShowStudioWorkbenchChrome(false, 'studio'), true);
  assert.equal(shouldShowStudioWorkbenchChrome(false, 'shahab'), true);
  assert.equal(shouldShowStudioWorkbenchChrome(true, 'studio'), true);
  assert.equal(shouldShowStudioWorkbenchChrome(true, 'graph'), false);
  assert.equal(shouldShowStudioWorkbenchChrome(true, 'storage'), false);
  assert.equal(shouldShowStudioWorkbenchChrome(true, 'shahab'), false);
});

test('resolveLeftRailWidthClass picks compact collapsed strip or adaptive expanded widths', () => {
  assert.equal(resolveLeftRailWidthClass(true, 'files'), 'lg:w-[48px]');
  assert.equal(resolveLeftRailWidthClass(true, 'effects'), 'lg:w-[48px]');
  assert.equal(resolveLeftRailWidthClass(false, 'effects'), 'lg:w-[264px] xl:w-[312px]');
  assert.equal(resolveLeftRailWidthClass(false, 'files'), 'lg:w-[232px] xl:w-[248px]');
});

test('getNextRovingTabIndex handles LTR/RTL horizontal, vertical, Home, and End keys', () => {
  assert.equal(getNextRovingTabIndex(0, 4, 'ArrowRight', false, 'horizontal'), 1);
  assert.equal(getNextRovingTabIndex(0, 4, 'ArrowLeft', false, 'horizontal'), 3);
  assert.equal(getNextRovingTabIndex(0, 4, 'ArrowLeft', true, 'horizontal'), 1);
  assert.equal(getNextRovingTabIndex(0, 4, 'ArrowRight', true, 'horizontal'), 3);
  assert.equal(getNextRovingTabIndex(1, 4, 'ArrowDown', true, 'vertical'), 2);
  assert.equal(getNextRovingTabIndex(0, 4, 'ArrowUp', true, 'vertical'), 3);
  assert.equal(getNextRovingTabIndex(2, 4, 'Home', false), 0);
  assert.equal(getNextRovingTabIndex(1, 4, 'End', true), 3);
  assert.equal(getNextRovingTabIndex(1, 4, 'Enter', false), null);
});
