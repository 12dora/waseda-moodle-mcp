import { describe, expect, it } from 'vitest';
import { displayName } from '../../src/core/format';

describe('displayName', () => {
  it('keeps one spelling when both name fields hold the whole name', () => {
    expect(displayName('WASEDA, Taro WASEDA  Taro')).toBe('WASEDA, Taro');
    expect(displayName('WASEDA, Taro waseda taro')).toBe('WASEDA, Taro');
    expect(displayName('早稲田 太郎 早稲田太郎')).toBe('早稲田 太郎');
  });

  it('leaves other names as they are, with whitespace collapsed', () => {
    expect(displayName('早稲田 太郎 ワセダ タロウ')).toBe('早稲田 太郎 ワセダ タロウ');
    expect(displayName('  Alice   Smith ')).toBe('Alice Smith');
    expect(displayName('Taro Taro Yamada')).toBe('Taro Taro Yamada');
    expect(displayName('Alice')).toBe('Alice');
    expect(displayName('')).toBe('');
  });

  it('keeps a name whose halves are only punctuation', () => {
    expect(displayName(', ,')).toBe(', ,');
  });
});
