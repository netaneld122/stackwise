use std::hint::black_box;

#[inline(never)]
fn leaf() -> usize {
    let data = [7usize; 8];
    black_box(data);
    data.len()
}

#[inline(never)]
fn parent() -> usize {
    leaf() + 1
}

fn main() {
    println!("{}", parent());
}
