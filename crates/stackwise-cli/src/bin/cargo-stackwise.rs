fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().collect::<Vec<_>>();
    if args.get(1).and_then(|arg| arg.to_str()) == Some("stackwise") {
        args.remove(1);
    }
    stackwise::run(args)
}
