class CHNGZ_ArtifactLight extends PointLightBase
{
	protected float m_BaseBrightness = 1.0;
	protected float m_Pulse;
	protected float m_PulseSpeed;
	protected float m_Time;

	void CHNGZ_ArtifactLight()
	{
		SetVisibleDuringDaylight(true);
		SetCastShadow(false);
		SetFlareVisible(false);
		SetRadiusTo(2.5);
		SetBrightnessTo(m_BaseBrightness);
	}

	void Setup(vector color, float radius, float brightness, float pulse, float pulseSpeed)
	{
		SetDiffuseColor(color[0], color[1], color[2]);
		SetAmbientColor(color[0], color[1], color[2]);
		SetRadiusTo(radius);
		m_BaseBrightness = brightness;
		m_Pulse = pulse;
		m_PulseSpeed = pulseSpeed;
		SetBrightnessTo(brightness);
	}

	override void OnFrameLightSource(IEntity other, float timeSlice)
	{
		super.OnFrameLightSource(other, timeSlice);

		if (m_Pulse <= 0)
			return;

		m_Time += timeSlice * m_PulseSpeed;
		SetBrightnessTo(m_BaseBrightness * (1 + m_Pulse * Math.Sin(m_Time * Math.PI2)));
	}
}

class CHNGZ_ArtifactBase extends ItemBase
{
	protected CHNGZ_ArtifactLight m_GlowLight;

	override void EEInit()
	{
		super.EEInit();

		// Свет создаётся только на клиенте; на выделенном сервере его нет.
		if (!GetGame().IsDedicatedServer())
			GetGame().GetCallQueue(CALL_CATEGORY_GAMEPLAY).CallLater(UpdateGlow, 100, false);
	}

	override void EEItemLocationChanged(notnull InventoryLocation oldLoc, notnull InventoryLocation newLoc)
	{
		super.EEItemLocationChanged(oldLoc, newLoc);

		if (!GetGame().IsDedicatedServer())
			UpdateGlow();
	}

	override void EEDelete(EntityAI parent)
	{
		DestroyGlow();
		super.EEDelete(parent);
	}

	bool ShouldGlow()
	{
		if (ConfigGetBool("glowInInventory"))
			return true;

		InventoryLocation loc = new InventoryLocation();
		GetInventory().GetCurrentInventoryLocation(loc);
		int type = loc.GetType();
		return type == InventoryLocationType.GROUND || type == InventoryLocationType.HANDS;
	}

	void UpdateGlow()
	{
		if (ShouldGlow())
			CreateGlow();
		else
			DestroyGlow();
	}

	protected void CreateGlow()
	{
		if (m_GlowLight)
			return;

		TFloatArray color = new TFloatArray();
		ConfigGetFloatArray("glowColor", color);
		vector rgb = "0.4 0.8 1.0";
		if (color.Count() >= 3)
			rgb = Vector(color[0], color[1], color[2]);

		m_GlowLight = CHNGZ_ArtifactLight.Cast(ScriptedLightBase.CreateLight(CHNGZ_ArtifactLight, GetPosition()));
		if (!m_GlowLight)
			return;

		m_GlowLight.Setup(rgb, ConfigGetFloat("glowRadius"), ConfigGetFloat("glowBrightness"), ConfigGetFloat("glowPulse"), ConfigGetFloat("glowPulseSpeed"));
		m_GlowLight.AttachOnObject(this, "0 0.05 0");
	}

	protected void DestroyGlow()
	{
		if (!m_GlowLight)
			return;

		m_GlowLight.Destroy();
		m_GlowLight = null;
	}
}
