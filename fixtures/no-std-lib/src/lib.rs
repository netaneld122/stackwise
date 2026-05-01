#![no_std]

use core::hint::black_box;

#[inline(never)]
pub fn fixed_stack_leaf() -> usize {
    let data = [3usize; 4];
    black_box(data);
    data.len()
}

#[inline(never)]
pub fn fixed_stack_parent() -> usize {
    fixed_stack_leaf() + 1
}
