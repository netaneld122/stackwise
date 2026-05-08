mod generated {
    include!(concat!(env!("OUT_DIR"), "/generated_calls.rs"));
}

fn main() {
    println!("{}", generated::tree_root(1));
}
