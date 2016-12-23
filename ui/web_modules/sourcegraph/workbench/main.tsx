import "sourcegraph/editor/authorshipWidget";
import "sourcegraph/editor/contrib";
import "sourcegraph/editor/GotoDefinitionWithClickEditorContribution";
import "sourcegraph/editor/vscode";
import "sourcegraph/workbench/overrides/instantiationService";

import "vs/editor/common/editorCommon";
import "vs/editor/contrib/codelens/browser/codelens";
import "vs/workbench/browser/parts/editor/stringEditor";
import "vs/workbench/parts/files/browser/explorerViewlet";
import "vs/workbench/parts/files/browser/files.contribution";

import URI from "vs/base/common/uri";
import { IInstantiationService } from "vs/platform/instantiation/common/instantiation";
import { ServiceCollection } from "vs/platform/instantiation/common/serviceCollection";
import { Workbench } from "vs/workbench/electron-browser/workbench";

import { registerEditorCallbacks } from "sourcegraph/editor/config";
import { configurePostStartup } from "sourcegraph/workbench/config";
import { setupServices } from "sourcegraph/workbench/services";

// init creates the editor interface.
export function init(domElement: HTMLDivElement, resource: URI): [Workbench, ServiceCollection] {
	const workspace = resource.with({ fragment: "" });
	const services = setupServices(domElement, workspace);
	const instantiationService = services.get(IInstantiationService) as IInstantiationService;

	const parent = domElement.parentElement;
	const workbench = instantiationService.createInstance(
		Workbench,
		parent,
		domElement,
		{ resource: workspace },
		{},
		services,
	);
	workbench.startup();

	registerEditorCallbacks();
	configurePostStartup(services);
	return [workbench, services];
}
