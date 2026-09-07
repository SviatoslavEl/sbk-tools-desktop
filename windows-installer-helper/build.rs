fn main() {
    embed_resource::compile("extractor.rc", embed_resource::NONE)
        .manifest_required()
        .expect("compile installed extractor manifest");
}
