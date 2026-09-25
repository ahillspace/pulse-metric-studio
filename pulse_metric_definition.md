Request Body schema: application/vnd.tableau.metricqueryservice.v1.CreateDefinitionRequest+json
certification	
object (tableau.metricqueryservice.types.v1.Certification)
is_certified	
boolean
modified_at	
string
modified_by	
string
comparisons	
object (tableau.metricqueryservice.types.v1.Comparisons)
comparisons	
Array of objects (tableau.metricqueryservice.types.v1.Comparisons.Comparison)
Array 
compare_config	
object (tableau.metricqueryservice.types.v1.CompareConfig)
comparison	
string
Enum: "TIME_COMPARISON_UNSPECIFIED" "TIME_COMPARISON_NONE" "TIME_COMPARISON_PREVIOUS_PERIOD" "TIME_COMPARISON_YEAR_AGO_PERIOD" "TIME_COMPARISON_FISCAL_YEAR_AGO_PERIOD"
The configuration of the period of metric values being compared.

comparison_period_override	
Array of objects (tableau.metricqueryservice.types.v1.ComparisonPeriodOverride)
Array 
comparison_time	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

granularity	
string
Enum: "GRANULARITY_UNSPECIFIED" "GRANULARITY_BY_YEAR" "GRANULARITY_BY_QUARTER" "GRANULARITY_BY_MONTH" "GRANULARITY_BY_WEEK" "GRANULARITY_BY_DAY" "GRANULARITY_BY_FISCAL_YEAR" "GRANULARITY_BY_FISCAL_QUARTER"
The granularity of the period of metric values being compared.

reference_time	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

index	
string <int64>
The pointer to the primary form of time comparison returned for the metric. The outcome of the primary comparison is shown in the detail view for the metric. Default is 0.

nestedComparison	
object (tableau.metricqueryservice.types.v1.Comparisons.Comparison)
compare_config	
object (tableau.metricqueryservice.types.v1.CompareConfig)
comparison	
string
Enum: "TIME_COMPARISON_UNSPECIFIED" "TIME_COMPARISON_NONE" "TIME_COMPARISON_PREVIOUS_PERIOD" "TIME_COMPARISON_YEAR_AGO_PERIOD" "TIME_COMPARISON_FISCAL_YEAR_AGO_PERIOD"
The configuration of the period of metric values being compared.

comparison_period_override	
Array of objects (tableau.metricqueryservice.types.v1.ComparisonPeriodOverride)
Array 
comparison_time	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

granularity	
string
Enum: "GRANULARITY_UNSPECIFIED" "GRANULARITY_BY_YEAR" "GRANULARITY_BY_QUARTER" "GRANULARITY_BY_MONTH" "GRANULARITY_BY_WEEK" "GRANULARITY_BY_DAY" "GRANULARITY_BY_FISCAL_YEAR" "GRANULARITY_BY_FISCAL_QUARTER"
The granularity of the period of metric values being compared.

reference_time	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

index	
string <int64>
The pointer to the primary form of time comparison returned for the metric. The outcome of the primary comparison is shown in the detail view for the metric. Default is 0.

datasource_goals	
Array of objects (tableau.metricqueryservice.types.v1.DatasourceGoalSpecification)
Array 
basic_specification	
object (tableau.metricqueryservice.types.v1.BasicSpecification)
filters	
Array of objects (tableau.metricqueryservice.types.v1.Filter)
The filters applied to the metric.

Array 
categorical_values	
Array of objects (tableau.metricqueryservice.types.v1.CategoricalValue)
(Required) An array listing the values of the field to be operated on when the filter is applied to the metric data. The type of each member can be one of string, boolean, or null.

Array 
bool_value	
boolean
The boolean value of the categorical value.

null_value	
string
Value: "NULL_VALUE"
The null value of the categorical value.

string_value	
string
The string value of the categorical value.

field	
string
(Required) The data source field that contains the values of metric filter options.

include_null	
boolean
If true, results will include null values. If false, null values will be excluded.

operator	
string
Enum: "OPERATOR_UNSPECIFIED" "OPERATOR_EQUAL" "OPERATOR_NOT_EQUAL"
(Required) The operator of the filter. Determines if the filter includes or excludes the specified categorical values.

values	
Array of strings
A list of filter names used to specified the metric data to be returned. Available filter names are specified in the metric definition configuration.

measure	
object (tableau.metricqueryservice.types.v1.Measure)
aggregation	
string
Enum: "AGGREGATION_UNSPECIFIED" "AGGREGATION_SUM" "AGGREGATION_AVERAGE" "AGGREGATION_MEDIAN" "AGGREGATION_MAX" "AGGREGATION_MIN" "AGGREGATION_COUNT" "AGGREGATION_COUNT_DISTINCT" "AGGREGATION_USER"
The method used to aggregate the values of the measured data source field.

field	
string
The data source field of the measure of the metric.

time_dimension	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

benchmark_sentiment_type	
string
Enum: "BENCHMARK_SENTIMENT_TYPE_UNSPECIFIED" "BENCHMARK_SENTIMENT_TYPE_NONE" "BENCHMARK_SENTIMENT_TYPE_ABOVE_THRESHOLD_IS_UNFAVORABLE" "BENCHMARK_SENTIMENT_TYPE_BELOW_THRESHOLD_IS_UNFAVORABLE"
minimum_granularity	
string
Enum: "GRANULARITY_UNSPECIFIED" "GRANULARITY_BY_YEAR" "GRANULARITY_BY_QUARTER" "GRANULARITY_BY_MONTH" "GRANULARITY_BY_WEEK" "GRANULARITY_BY_DAY" "GRANULARITY_BY_FISCAL_YEAR" "GRANULARITY_BY_FISCAL_QUARTER"
The granularity of the period of metric values being compared.

name	
string
Optional custom name for the datasource benchmark.

threshold_basic_specification	
object (tableau.metricqueryservice.types.v1.BasicSpecification)
filters	
Array of objects (tableau.metricqueryservice.types.v1.Filter)
The filters applied to the metric.

Array 
categorical_values	
Array of objects (tableau.metricqueryservice.types.v1.CategoricalValue)
(Required) An array listing the values of the field to be operated on when the filter is applied to the metric data. The type of each member can be one of string, boolean, or null.

Array 
bool_value	
boolean
The boolean value of the categorical value.

null_value	
string
Value: "NULL_VALUE"
The null value of the categorical value.

string_value	
string
The string value of the categorical value.

field	
string
(Required) The data source field that contains the values of metric filter options.

include_null	
boolean
If true, results will include null values. If false, null values will be excluded.

operator	
string
Enum: "OPERATOR_UNSPECIFIED" "OPERATOR_EQUAL" "OPERATOR_NOT_EQUAL"
(Required) The operator of the filter. Determines if the filter includes or excludes the specified categorical values.

values	
Array of strings
A list of filter names used to specified the metric data to be returned. Available filter names are specified in the metric definition configuration.

measure	
object (tableau.metricqueryservice.types.v1.Measure)
aggregation	
string
Enum: "AGGREGATION_UNSPECIFIED" "AGGREGATION_SUM" "AGGREGATION_AVERAGE" "AGGREGATION_MEDIAN" "AGGREGATION_MAX" "AGGREGATION_MIN" "AGGREGATION_COUNT" "AGGREGATION_COUNT_DISTINCT" "AGGREGATION_USER"
The method used to aggregate the values of the measured data source field.

field	
string
The data source field of the measure of the metric.

time_dimension	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

threshold_viz_state_specification	
object (tableau.metricqueryservice.types.v1.VizStateSpecification)
viz_state_string	
string
A Base64 encoded string, typically generated via the advanced option in the Tableau user interface.

viz_state_specification	
object (tableau.metricqueryservice.types.v1.VizStateSpecification)
viz_state_string	
string
A Base64 encoded string, typically generated via the advanced option in the Tableau user interface.

description	
string
The description of the metric definition.

extension_options	
object (tableau.metricqueryservice.types.v1.ExtensionOptions)
allowed_dimensions	
Array of strings
(Required) Specifies which data source dimensions can be used as filters by metrics created using the definition. Values included are a comma separated list of data source column names.

allowed_granularities	
Array of arrays
(Required) Specifies the span of time time that can be used to calculate metrics created using the definition.

correlation_candidate_definition_ids	
Array of strings
A list of the candidate definition IDs of metrics that are considered for correlation.

custom_calendar	
object (tableau.metricqueryservice.types.v1.CustomCalendarConfiguration)
Specifies the data source columns containing the name of the month and the number of the day, week, month, quarter, and year that are associated with a given (Gregorian) calendar date of a custom calendar day.

day_of_year_field	
string
The name of the day of the year column.

month_name_field	
string
The name of column that contains the month name.

month_of_year_field	
string
The name of the day of the month of the year column.

quarter_field	
string
The name of the quarter column.

reference_date_field	
string
The name of the column that contains the (Gregorian) calendar date.

week_of_year_field	
string
The name of the week of the year column.

year_field	
string
The name of the year column.

items	
string
Enum: "GRANULARITY_UNSPECIFIED" "GRANULARITY_BY_YEAR" "GRANULARITY_BY_QUARTER" "GRANULARITY_BY_MONTH" "GRANULARITY_BY_WEEK" "GRANULARITY_BY_DAY" "GRANULARITY_BY_FISCAL_YEAR" "GRANULARITY_BY_FISCAL_QUARTER"
The granularity of the period of metric values being compared.

offset_from_today	
integer <int32>
The offset from today in days. Default is 0.

use_dynamic_offset	
boolean
If true, calculates the offset from today and off_set_from_today is ignored. Default is false.

insights_options	
object (tableau.metricqueryservice.types.v1.InsightsOptions)
nestedInsightSetting	
object (tableau.metricqueryservice.types.v1.InsightsOptions.InsightSetting)
benchmark_breakdown_options	
object (tableau.metricqueryservice.types.v1.BenchmarkBreakdownOptions)
limit	
integer <int32>
contributors_options	
object (tableau.metricqueryservice.types.v1.ContributorsOptions)
limit	
integer <int32>
disabled	
boolean
Determines whether or not the insight setting is disabled. Defaults to false. to false.

type	
string
Enum: "INSIGHT_TYPE_UNSPECIFIED" "INSIGHT_TYPE_RISKY_MONOPOLY" "INSIGHT_TYPE_TOP_DRIVERS" "INSIGHT_TYPE_RECORD_LEVEL_OUTLIERS" "INSIGHT_TYPE_CURRENT_TREND" "INSIGHT_TYPE_NEW_TREND" "INSIGHT_TYPE_TOP_DIMENSION_MEMBER_MOVERS" "INSIGHT_TYPE_METRIC_FORECAST" "INSIGHT_TYPE_BOTTOM_CONTRIBUTORS" "INSIGHT_TYPE_TOP_DETRACTORS" "INSIGHT_TYPE_UNUSUAL_CHANGE" "INSIGHT_TYPE_BENCHMARK_BREAKDOWN" "INSIGHT_TYPE_CORRELATED_METRIC" "INSIGHT_TYPE_TOP_CONTRIBUTORS"
The type of the insight setting.

Note: INSIGHT_TYPE_GOAL_BREAKDOWN is deprecated and replaced with INSIGHT_TYPE_BREAKDOWN_BENCHMARK. INSIGHT_TYPE_GOAL_BREAKDOWN is no longer supported and may be removed in a future version of the API.

settings	
Array of objects (tableau.metricqueryservice.types.v1.InsightsOptions.InsightSetting)
Array 
benchmark_breakdown_options	
object (tableau.metricqueryservice.types.v1.BenchmarkBreakdownOptions)
limit	
integer <int32>
contributors_options	
object (tableau.metricqueryservice.types.v1.ContributorsOptions)
limit	
integer <int32>
disabled	
boolean
Determines whether or not the insight setting is disabled. Defaults to false. to false.

type	
string
Enum: "INSIGHT_TYPE_UNSPECIFIED" "INSIGHT_TYPE_RISKY_MONOPOLY" "INSIGHT_TYPE_TOP_DRIVERS" "INSIGHT_TYPE_RECORD_LEVEL_OUTLIERS" "INSIGHT_TYPE_CURRENT_TREND" "INSIGHT_TYPE_NEW_TREND" "INSIGHT_TYPE_TOP_DIMENSION_MEMBER_MOVERS" "INSIGHT_TYPE_METRIC_FORECAST" "INSIGHT_TYPE_BOTTOM_CONTRIBUTORS" "INSIGHT_TYPE_TOP_DETRACTORS" "INSIGHT_TYPE_UNUSUAL_CHANGE" "INSIGHT_TYPE_BENCHMARK_BREAKDOWN" "INSIGHT_TYPE_CORRELATED_METRIC" "INSIGHT_TYPE_TOP_CONTRIBUTORS"
The type of the insight setting.

Note: INSIGHT_TYPE_GOAL_BREAKDOWN is deprecated and replaced with INSIGHT_TYPE_BREAKDOWN_BENCHMARK. INSIGHT_TYPE_GOAL_BREAKDOWN is no longer supported and may be removed in a future version of the API.

name	
string
The name of the metric definition.

related_links	
Array of objects (tableau.metricqueryservice.types.v1.Link)
Array 
link_name	
string
link_url	
string
representation_options	
object (tableau.metricqueryservice.types.v1.RepresentationOptions)
currency_code	
string
Enum: "CURRENCY_CODE_UNSPECIFIED" "CURRENCY_CODE_AED" "CURRENCY_CODE_AFN" "CURRENCY_CODE_ALL" "CURRENCY_CODE_AMD" "CURRENCY_CODE_ARS" "CURRENCY_CODE_AUD" "CURRENCY_CODE_AZN" "CURRENCY_CODE_BAM" "CURRENCY_CODE_BDT" "CURRENCY_CODE_BGN" "CURRENCY_CODE_BHD" "CURRENCY_CODE_BND" "CURRENCY_CODE_BOB" "CURRENCY_CODE_BRL" "CURRENCY_CODE_BTN" "CURRENCY_CODE_BWP" "CURRENCY_CODE_BYN" "CURRENCY_CODE_BZD" "CURRENCY_CODE_CAD" "CURRENCY_CODE_CDF" "CURRENCY_CODE_CHF" "CURRENCY_CODE_CLP" "CURRENCY_CODE_CNY" "CURRENCY_CODE_COP" "CURRENCY_CODE_CRC" "CURRENCY_CODE_CUP" "CURRENCY_CODE_CZK" "CURRENCY_CODE_DKK" "CURRENCY_CODE_DOP" "CURRENCY_CODE_DZD" "CURRENCY_CODE_EGP" "CURRENCY_CODE_ERN" "CURRENCY_CODE_ETB" "CURRENCY_CODE_EUR" "CURRENCY_CODE_GBP" "CURRENCY_CODE_GEL" "CURRENCY_CODE_GTQ" "CURRENCY_CODE_HKD" "CURRENCY_CODE_HNL" "CURRENCY_CODE_HTG" "CURRENCY_CODE_HUF" "CURRENCY_CODE_IDR" "CURRENCY_CODE_ILS" "CURRENCY_CODE_INR" "CURRENCY_CODE_IQD" "CURRENCY_CODE_IRR" "CURRENCY_CODE_ISK" "CURRENCY_CODE_JMD" "CURRENCY_CODE_JOD" "CURRENCY_CODE_JPY" "CURRENCY_CODE_KES" "CURRENCY_CODE_KGS" "CURRENCY_CODE_KHR" "CURRENCY_CODE_KRW" "CURRENCY_CODE_KWD" "CURRENCY_CODE_KZT" "CURRENCY_CODE_LAK" "CURRENCY_CODE_LBP" "CURRENCY_CODE_LKR" "CURRENCY_CODE_LYD" "CURRENCY_CODE_MAD" "CURRENCY_CODE_MDL" "CURRENCY_CODE_MKD" "CURRENCY_CODE_MMK" "CURRENCY_CODE_MNT" "CURRENCY_CODE_MVR" "CURRENCY_CODE_MXN" "CURRENCY_CODE_MYR" "CURRENCY_CODE_NAD" "CURRENCY_CODE_NGN" "CURRENCY_CODE_NIO" "CURRENCY_CODE_NOK" "CURRENCY_CODE_NPR" "CURRENCY_CODE_NZD" "CURRENCY_CODE_OMR" "CURRENCY_CODE_PAB" "CURRENCY_CODE_PEN" "CURRENCY_CODE_PHP" "CURRENCY_CODE_PKR" "CURRENCY_CODE_PLN" "CURRENCY_CODE_PYG" "CURRENCY_CODE_QAR" "CURRENCY_CODE_RON" "CURRENCY_CODE_RSD" "CURRENCY_CODE_RUB" "CURRENCY_CODE_RWF" "CURRENCY_CODE_SAR" "CURRENCY_CODE_SEK" "CURRENCY_CODE_SGD" "CURRENCY_CODE_SOS" "CURRENCY_CODE_SYP" "CURRENCY_CODE_THB" "CURRENCY_CODE_TMT" "CURRENCY_CODE_TND" "CURRENCY_CODE_TRY" "CURRENCY_CODE_TTD" "CURRENCY_CODE_UAH" "CURRENCY_CODE_USD" "CURRENCY_CODE_UYU" "CURRENCY_CODE_UZS" "CURRENCY_CODE_VED" "CURRENCY_CODE_VND" "CURRENCY_CODE_XAF" "CURRENCY_CODE_XOF" "CURRENCY_CODE_YER" "CURRENCY_CODE_ZAR" "CURRENCY_CODE_ANG" "CURRENCY_CODE_AOA" "CURRENCY_CODE_AWG" "CURRENCY_CODE_BBD" "CURRENCY_CODE_BIF" "CURRENCY_CODE_BMD" "CURRENCY_CODE_BOV" "CURRENCY_CODE_BSD" "CURRENCY_CODE_CHE" "CURRENCY_CODE_CHW" "CURRENCY_CODE_CLF" "CURRENCY_CODE_COU" "CURRENCY_CODE_CUC" "CURRENCY_CODE_CVE" "CURRENCY_CODE_DJF" "CURRENCY_CODE_FJD" "CURRENCY_CODE_FKP" "CURRENCY_CODE_GHS" "CURRENCY_CODE_GIP" "CURRENCY_CODE_GMD" "CURRENCY_CODE_GNF" "CURRENCY_CODE_GYD" "CURRENCY_CODE_KMF" "CURRENCY_CODE_KPW" "CURRENCY_CODE_KYD" "CURRENCY_CODE_LRD" "CURRENCY_CODE_LSL" "CURRENCY_CODE_MGA" "CURRENCY_CODE_MOP" "CURRENCY_CODE_MRU" "CURRENCY_CODE_MUR" "CURRENCY_CODE_MWK" "CURRENCY_CODE_MXV" "CURRENCY_CODE_MZN" "CURRENCY_CODE_PGK" "CURRENCY_CODE_SBD" "CURRENCY_CODE_SCR" "CURRENCY_CODE_SDG" "CURRENCY_CODE_SHP" "CURRENCY_CODE_SLE" "CURRENCY_CODE_SRD" "CURRENCY_CODE_SSP" "CURRENCY_CODE_STN" "CURRENCY_CODE_SVC" "CURRENCY_CODE_SZL" "CURRENCY_CODE_TJS" "CURRENCY_CODE_TOP" "CURRENCY_CODE_TWD" "CURRENCY_CODE_TZS" "CURRENCY_CODE_UGX" "CURRENCY_CODE_USN" "CURRENCY_CODE_UYI" "CURRENCY_CODE_UYW" "CURRENCY_CODE_VES" "CURRENCY_CODE_VUV" "CURRENCY_CODE_WST" "CURRENCY_CODE_XCD" "CURRENCY_CODE_XPF" "CURRENCY_CODE_ZMW" "CURRENCY_CODE_ZWL"
(Optional) The ISO 4217 code for the currency represented in the definition. USD is the default currency code if none is supplied in the request.

decimal_places	
integer
The number of decimal places to use for values of the metric.

nestedNumberUnits	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.NumberUnits)
plural_noun	
string
The plural noun to use for the number unit.

singular_noun	
string
The singular noun to use for the number unit.

nestedRowLevelEntityNames	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.RowLevelEntityNames)
entity_name_plural	
string
The plural form of the expression describing the row level dimension of a data source.

entity_name_singular	
string
The singular form of the expression describing the row level dimension of a data source. The singular form of the expression describing the row level dimension of a data source.

nestedRowLevelIDField	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.RowLevelIDField)
identifier_col	
string
The data source column that contains the identifier_label of a row whose values will be aggregated for the metric.

identifier_label	
string
The value in identifier_col column that causes the row containing the label to be aggregated as part of the metric.

nestedRowLevelNameField	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.RowLevelNameField)
name_col	
string
The data source column that contains the name of a row whose values will be aggregated for the metric.

number_units	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.NumberUnits)
plural_noun	
string
The plural noun to use for the number unit.

singular_noun	
string
The singular noun to use for the number unit.

positive_only	
boolean
row_level_entity_names	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.RowLevelEntityNames)
entity_name_plural	
string
The plural form of the expression describing the row level dimension of a data source.

entity_name_singular	
string
The singular form of the expression describing the row level dimension of a data source. The singular form of the expression describing the row level dimension of a data source.

row_level_id_field	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.RowLevelIDField)
identifier_col	
string
The data source column that contains the identifier_label of a row whose values will be aggregated for the metric.

identifier_label	
string
The value in identifier_col column that causes the row containing the label to be aggregated as part of the metric.

row_level_name_field	
object (tableau.metricqueryservice.types.v1.RepresentationOptions.RowLevelNameField)
name_col	
string
The data source column that contains the name of a row whose values will be aggregated for the metric.

sentiment_type	
string
Enum: "SENTIMENT_TYPE_UNSPECIFIED" "SENTIMENT_TYPE_NONE" "SENTIMENT_TYPE_UP_IS_GOOD" "SENTIMENT_TYPE_DOWN_IS_GOOD"
Whether the favorable direction of the metric to increase or decrease, or is neutral.

type	
string
Enum: "NUMBER_FORMAT_TYPE_UNSPECIFIED" "NUMBER_FORMAT_TYPE_NUMBER" "NUMBER_FORMAT_TYPE_PERCENT" "NUMBER_FORMAT_TYPE_CURRENCY"
The number format type of the definition.

specification	
object (tableau.metricqueryservice.types.v1.DefinitionSpecification)
abstract_query_specification	
object (tableau.metricqueryservice.types.v1.AbstractQuerySpecification)
abstract_query_string	
string
basic_specification	
object (tableau.metricqueryservice.types.v1.BasicSpecification)
filters	
Array of objects (tableau.metricqueryservice.types.v1.Filter)
The filters applied to the metric.

Array 
categorical_values	
Array of objects (tableau.metricqueryservice.types.v1.CategoricalValue)
(Required) An array listing the values of the field to be operated on when the filter is applied to the metric data. The type of each member can be one of string, boolean, or null.

Array 
bool_value	
boolean
The boolean value of the categorical value.

null_value	
string
Value: "NULL_VALUE"
The null value of the categorical value.

string_value	
string
The string value of the categorical value.

field	
string
(Required) The data source field that contains the values of metric filter options.

include_null	
boolean
If true, results will include null values. If false, null values will be excluded.

operator	
string
Enum: "OPERATOR_UNSPECIFIED" "OPERATOR_EQUAL" "OPERATOR_NOT_EQUAL"
(Required) The operator of the filter. Determines if the filter includes or excludes the specified categorical values.

values	
Array of strings
A list of filter names used to specified the metric data to be returned. Available filter names are specified in the metric definition configuration.

measure	
object (tableau.metricqueryservice.types.v1.Measure)
aggregation	
string
Enum: "AGGREGATION_UNSPECIFIED" "AGGREGATION_SUM" "AGGREGATION_AVERAGE" "AGGREGATION_MEDIAN" "AGGREGATION_MAX" "AGGREGATION_MIN" "AGGREGATION_COUNT" "AGGREGATION_COUNT_DISTINCT" "AGGREGATION_USER"
The method used to aggregate the values of the measured data source field.

field	
string
The data source field of the measure of the metric.

time_dimension	
object (tableau.metricqueryservice.types.v1.TimeDimension)
field	
string
The data source field used for the time dimension of the metric.

datasource	
object (tableau.metricqueryservice.types.v1.Datasource)
id	
string
The LUID for the datasource for a definition.

id_type	
string
Enum: "DATASOURCE_ID_TYPE_UNSPECIFIED" "DATASOURCE_ID_TYPE_LUID" "DATASOURCE_ID_TYPE_WORKBOOK_DATASOURCE"
vizql_session_id	
string
is_running_total	
boolean
If true, metrics related to a definition have a running total. If false, then totals are only for the defined time period of the measure. Defaults to false. Must be false when temporality is set to TEMPORALITY_LATEST_POINT_IN_TIME.

viz_state_specification	
object (tableau.metricqueryservice.types.v1.VizStateSpecification)
viz_state_string	
string
A Base64 encoded string, typically generated via the advanced option in the Tableau user interface.

temporality	
string
Enum: "TEMPORALITY_UNSPECIFIED" "TEMPORALITY_OVER_TIME" "TEMPORALITY_LATEST_POINT_IN_TIME"
Optional. Indicates whether the metric represents a cumulative aggregation over a time period or a latest point-in-time snapshot value. Omitting this field or sending TEMPORALITY_UNSPECIFIED is equivalent to TEMPORALITY_OVER_TIME.

Enum values:

TEMPORALITY_UNSPECIFIED — Default value, treated as TEMPORALITY_OVER_TIME.
TEMPORALITY_OVER_TIME — Metric represents a cumulative aggregation over a time period.
TEMPORALITY_LATEST_POINT_IN_TIME — Metric represents the latest snapshot value.
Constraint: When temporality is TEMPORALITY_LATEST_POINT_IN_TIME, the is_running_total field must be false. Setting both to conflicting values returns HTTP 400 with error code metric_validation_point_in_time_running_total_conflict.

Responses
201
Successful.

400
Invalid Request.

401
Unable to authenticate user. Credentials are missing or invalid.

404
Bad Request. The requested resource could not be found.

500
Unknown error. There was an internal server error.

503
Service unavailable.