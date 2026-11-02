# Tableau Pulse provider contract capture

`pulse-provider-contracts.sanitized.json` is the versioned RP-00 provider contract record for Tableau Cloud REST API 3.27.

The capture replaces site, datasource, definition, metric, user, group, and value identifiers.
It contains no credentials or personal data.

The fixture records the following observable provider boundaries:

- Definition inventory and exact metric envelopes cite the official [Tableau Pulse REST reference](https://help.tableau.com/current/api/rest_api/en-us/REST/TAG/index.html#tag/Pulse).
- Get-or-create request and response envelopes cite the official [Get or Create Metric operation](https://help.tableau.com/current/api/rest_api/en-us/REST/TAG/index.html#tag/Pulse/operation/MetricQueryService_GetOrCreateMetric).
- VDS metadata rows cite the official [VDS datasource metadata contract](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_get_data_source_info.html).
- VDS distinct-value rows cite the official [VDS query contract](https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html).
- Subscription and follower-count envelopes cite the official [Tableau Pulse REST reference](https://help.tableau.com/current/api/rest_api/en-us/REST/TAG/index.html#tag/Pulse).

Behavior tests load this serialized provider contract and pass its responses through the public Pulse clients and normalizers.
Unknown envelopes and rows remain explicit provider-contract failures.
