use schemars::schema_for;
use stackwise_core::StackwiseReport;

#[test]
fn report_schema_is_generatable() {
    let schema = schema_for!(StackwiseReport);
    let json = serde_json::to_value(schema).unwrap();
    assert_eq!(json["title"], "StackwiseReport");
}
