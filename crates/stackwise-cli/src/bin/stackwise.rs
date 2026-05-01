fn main() -> anyhow::Result<()> {
    stackwise::run(std::env::args_os())
}
